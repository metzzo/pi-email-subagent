import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { PiRpcClient } from "./helpers/rpc-client.ts";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
it(
  "restores one genuine persisted Pi session without replaying direct work",
  { timeout: 180000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-e2e-"));
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    const effects = join(root, "restore-effects");
    const calls = join(root, "calls");
    const script = join(root, "restore.py");
    await writeFile(
      script,
      "import time\nfrom pi_mechanistic import arguments,invocation,progress,success\na=arguments(); open('restore-effects','a').write(invocation()['jobId']+'\\n'); progress('running',10); time.sleep(60); success('restored observation complete')\n",
    );
    await writeFile(
      join(agent, "subagents.json"),
      JSON.stringify({
        lifecycle: {
          runTimeoutMs: 65000,
          abortTimeoutMs: 200,
          disposeTimeoutMs: 200,
        },
        mechanisticPrograms: { ci: { python: "python3", script, cwd: root } },
      }),
    );
    const ext = [
      resolve("src/index.ts"),
      resolve("test/helpers/mechanistic-ux-provider.ts"),
    ];
    const env = { UX_MODEL_CALLS: calls, OPENAI_API_KEY: "unused" };
    let a: PiRpcClient | undefined,
      b: PiRpcClient | undefined,
      c: PiRpcClient | undefined;
    try {
      a = PiRpcClient.launch({
        cwd: root,
        agentDir: agent,
        model: "ux-local/ux-local",
        extensions: ext,
        env,
        persistSession: true,
        approveProject: true,
      });
      await a.prompt("bootstrap genuine session");
      await a.waitForSettlement(0, 30000);
      const state = await a.getState();
      const sessionFile = (state.data as { sessionFile?: string }).sessionFile;
      assert.ok(sessionFile);
      await a.close();
      assert.equal(await readFile(calls, "utf8"), "generation\n");
      b = PiRpcClient.launch({
        cwd: root,
        agentDir: agent,
        model: "ux-local/ux-local",
        extensions: ext,
        env,
        persistSession: true,
        session: sessionFile,
        approveProject: true,
      });
      const mark = b.mark();
      b.send({ type: "prompt", message: "/agents run ci.restore {}" });
      const acceptance = await b.waitFor(
        (l) =>
          l.type === "message_end" &&
          (l.message as { customType?: string }).customType ===
            "pi-email-subagent.command",
        "acceptance",
        30000,
        mark,
      );
      const id = (acceptance.message as { details?: { jobId?: string } })
        .details?.jobId;
      assert.ok(id);
      for (
        let i = 0;
        i < 300 &&
        !(await readFile(effects, "utf8").catch(() => "")).includes(id);
        i++
      )
        await pause(100);
      b.kill("SIGTERM");
      await Promise.race([b.waitForClose(), pause(10000)]);
      assert.equal(await readFile(calls, "utf8"), "generation\n");
      c = PiRpcClient.launch({
        cwd: root,
        agentDir: agent,
        model: "ux-local/ux-local",
        extensions: ext,
        env,
        persistSession: true,
        session: sessionFile,
        approveProject: true,
      });
      const outcome = await c.waitFor(
        (l) =>
          l.type === "message_end" &&
          (l.message as { customType?: string }).customType ===
            "pi-email-subagent.email",
        "recovered outcome",
        60000,
        0,
      );
      assert.equal(
        (outcome.message as { details?: { triggerTurn?: boolean } }).details
          ?.triggerTurn,
        false,
      );
      await c.close();
      assert.equal(await readFile(effects, "utf8"), id + "\n");
      assert.equal(await readFile(calls, "utf8"), "generation\n");
    } finally {
      for (const client of [a, b, c]) client?.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);
