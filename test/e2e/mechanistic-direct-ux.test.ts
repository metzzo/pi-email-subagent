import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { PiRpcClient } from "./helpers/rpc-client.ts";
import { MailStore, parseMailEvent } from "../../src/mail-store.ts";

const observer = join(
  process.cwd(),
  "test/e2e/helpers/provider-request-observer-extension.ts",
);
const production = join(process.cwd(), "src/index.ts");
const statusProgram = join(process.cwd(), "src/python/examples/status_file.py");

it(
  "real Pi exposes and directly runs the packaged status observer without model requests",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mechanistic-direct-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(root, "status.txt"), "ready\n");
    await writeFile(
      join(agentDir, "subagents.json"),
      JSON.stringify({
        mechanisticPrograms: {
          ci: {
            python: "python3",
            script: statusProgram,
            cwd: root,
            description: "Observe local status",
            inputExamples: ["{}"],
          },
        },
      }),
    );
    const client = PiRpcClient.launch({
      cwd: root,
      agentDir,
      model: "openai/gpt-4.1-nano",
      extensions: [production, observer],
      approveProject: true,
      env: { OPENAI_API_KEY: "deterministic-unused", PI_OFFLINE: "1" },
    });
    try {
      const state = await client.getState();
      const sessionId = (state.data as { sessionId?: string }).sessionId;
      assert.ok(sessionId);
      const models = await client.getAvailableModels();
      const available =
        (models.data as { models?: Array<{ provider?: string; id?: string }> })
          .models ?? [];
      assert.ok(
        available.some(
          (model) => model.provider === "openai" && model.id === "gpt-4.1-nano",
        ),
      );
      await client.prompt("/agents programs");

      await client.prompt("/agents program ci");
      await client.prompt("/agents run ci.main-status {}");
      const rpcText = JSON.stringify(client.events());
      assert.match(rpcText, /pi-email-subagent/);
      assert.match(rpcText, /\{\}/);
      assert.doesNotMatch(rpcText, /agent_start|agent_end|agent_settled/);
      assert.equal(
        await readFile(join(root, ".provider-requests")).catch(() => ""),
        "",
      );
      await client.close();
      const close = await client.waitForClose();
      assert.equal(close.code, 0);
      assert.equal(close.signal, null);
      const journalPath = join(agentDir, "subagents", sessionId, "mail.jsonl");
      const store = new MailStore(journalPath);
      await store.init();
      const events = (await readFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => parseMailEvent(JSON.parse(line)));
      const terminal = events.find((event) => event.type === "job.terminal");
      assert.ok(terminal && "job" in terminal);
      const job = store.getJob(terminal.job.id);
      assert.ok(job);
      assert.equal(job.address, "ci.main-status@mechanistic.com");
      assert.equal(job.phase, "terminal");
      assert.equal(job.result, "success");
      assert.equal(job.outcomeDeliveryState, "delivered");
      assert.equal(job.triggerTurn, false);
      assert.equal(job.cleanup?.state, "confirmed");
      assert.equal(job.cleanup?.childExited, true);
      assert.equal(job.cleanup?.pipesClosed, true);
      assert.equal(store.countPendingJobs(), 0);
      assert.ok(job.outcomeMailId);
      assert.equal(store.get(job.outcomeMailId)?.triggerTurn, false);
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
