import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { PiRpcClient } from "./helpers/rpc-client.ts";
import { MailStore } from "../../src/mail-store.ts";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closeWithin = async (client: PiRpcClient, ms: number) =>
  new Promise<Awaited<ReturnType<PiRpcClient["waitForClose"]>> | undefined>(
    (resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      client.waitForClose().then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    },
  );
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
      const sessionId = (state.data as { sessionId?: string }).sessionId;
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
      assert.equal(
        (acceptance.message as { details?: { sessionId?: string } }).details
          ?.sessionId,
        sessionId,
      );
      assert.equal(
        b
          .events()
          .some((event) =>
            ["agent_start", "agent_end", "agent_settled"].includes(event.type),
          ),
        false,
      );
      assert.equal(
        (acceptance.message as { details?: { address?: string } }).details
          ?.address,
        "ci.restore@mechanistic.com",
      );
      for (
        let i = 0;
        i < 300 &&
        !(await readFile(effects, "utf8").catch(() => "")).includes(id);
        i++
      )
        await pause(100);
      assert.equal(await readFile(effects, "utf8"), id + "\n");
      b.kill("SIGTERM");
      const bClose = await closeWithin(b, 10000);
      assert.ok(bClose);
      assert.equal(bClose.code, 143);
      assert.equal(bClose.signal, null);
      assert.equal(await readFile(calls, "utf8"), "generation\n");
      const journal = join(agent, "subagents", sessionId!, "mail.jsonl");
      const storeBefore = new MailStore(journal);
      await storeBefore.init();
      const jobBefore = storeBefore.getJob(id!);
      assert.ok(jobBefore);
      assert.equal(jobBefore.phase, "terminal");
      assert.equal(jobBefore.address, "ci.restore@mechanistic.com");
      assert.equal(jobBefore.result, "forced_stop");
      assert.equal(jobBefore.outcomeMailId !== undefined, true);
      assert.equal(jobBefore.outcomeDeliveryState, "queued");
      assert.equal(jobBefore.cleanup?.state, "confirmed");
      assert.equal(jobBefore.cleanup?.childExited, true);
      assert.equal(jobBefore.cleanup?.pipesClosed, true);
      assert.equal(storeBefore.countPendingJobs(), 0);
      assert.ok(jobBefore.pid);
      assert.throws(
        () => process.kill(jobBefore.pid!, 0),
        (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
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

      assert.equal(await readFile(calls, "utf8"), "generation\n");
      assert.equal(
        c
          .events()
          .some((event) =>
            ["agent_start", "agent_end", "agent_settled"].includes(event.type),
          ),
        false,
      );
      const messages = await c.getMessages();
      const restored = (
        (
          messages.data as {
            messages?: Array<{
              role?: string;
              customType?: string;
              details?: { id?: string; triggerTurn?: boolean };
            }>;
          }
        ).messages ?? []
      ).find(
        (message) =>
          message.role === "custom" &&
          message.customType === "pi-email-subagent.email" &&
          message.details?.id === jobBefore.outcomeMailId,
      );
      assert.ok(restored);
      assert.equal(restored.details?.triggerTurn, false);
      assert.equal(
        (restored.details as { from?: string }).from,
        jobBefore.address,
      );
      assert.equal(
        c
          .events()
          .some((event) =>
            ["agent_start", "agent_end", "agent_settled"].includes(event.type),
          ),
        false,
      );
      await c.close();
      const store = new MailStore(journal);
      await store.init();
      const job = store.getJob(id!);
      assert.ok(job);
      assert.equal(job.id, jobBefore.id);
      assert.equal(job.outcomeMailId, jobBefore.outcomeMailId);
      assert.equal(job.result, "forced_stop");
      assert.equal(job.signal, "SIGTERM");
      assert.equal(job.triggerTurn, false);
      assert.equal(job.outcomeDeliveryState, "delivered");
      assert.equal(store.countPendingJobs(), 0);
      assert.equal(job.cleanup?.childExited, true);
      assert.equal(job.cleanup?.pipesClosed, true);
      assert.equal(job.cleanup?.state, "confirmed");
      assert.equal(await readFile(effects, "utf8"), id + "\n");
      assert.equal(await readFile(calls, "utf8"), "generation\n");
    } finally {
      for (const client of [a, b, c]) client?.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);
