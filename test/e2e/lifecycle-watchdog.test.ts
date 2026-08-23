/** Real SDK-worker/Bash regressions for active-tool-aware lifecycle deadlines. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const WORKER_ADDRESS = "worker.work-e2e@mock-e2e.com";

function toolEnd(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function assistantText(text: string) {
  return (line: RpcLine) => {
    if (line.type !== "message_end") return false;
    const message = line.message as { role?: string; content?: unknown } | undefined;
    return message?.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => (part as { type?: string; text?: string }).type === "text"
        && String((part as { text?: string }).text ?? "").includes(text));
  };
}

function sendResult(line: RpcLine): any {
  return (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
}

function waitResult(line: RpcLine): { items: { requestId: string; state: string }[] } {
  const result = (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
  assert.ok(result, "wait_for_replies returned no parsed result details");
  return result as { items: { requestId: string; state: string }[] };
}

async function readRegistry(agentDir: string, sessionId: string): Promise<any> {
  return JSON.parse(await readFile(join(agentDir, "subagents", sessionId, "registry.json"), "utf8"));
}

async function eventuallyRegistry(
  agentDir: string,
  sessionId: string,
  predicate: (registry: any) => boolean,
  description: string,
): Promise<any> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const registry = await readRegistry(agentDir, sessionId);
      last = registry;
      if (predicate(registry)) return registry;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  assert.fail(`Timed out waiting for registry ${description}: ${JSON.stringify(last)?.slice(0, 500)}`);
}

async function readJournal(agentDir: string, sessionId: string): Promise<any[]> {
  const raw = await readFile(join(agentDir, "subagents", sessionId, "mail.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function correlatedBashResult(sessionFile: string): { callId: string; result: any } {
  const entries = SessionManager.open(sessionFile).getBranch();
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as any);
  const call = messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content)
    .find((part) => part?.type === "toolCall" && part.name === "bash");
  assert.ok(call?.id, "worker session contains a Bash tool call ID");
  const result = messages.find((message) => message.role === "toolResult"
    && message.toolName === "bash" && message.toolCallId === call.id);
  assert.ok(result, "worker session contains the correlated Bash result");
  return { callId: call.id, result };
}

async function startScenario(mode: "IDLE" | "RUN") {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-watchdog-e2e-agent-"));
  const readinessPath = join(agentDir, `watchdog-${mode.toLowerCase()}.json`);
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, EXTENSION],
  });
  const state = await client.getState();
  assert.equal(state.success, true, client.stderr);
  const sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
  assert.ok(sessionId);
  return { client, agentDir, readinessPath, sessionId };
}

describe("real active-tool lifecycle watchdog", { concurrency: false }, () => {
  it("lets an output-silent built-in Bash child outlive idle and answer", { timeout: 120_000 }, async () => {
    const { client, agentDir, readinessPath, sessionId } = await startScenario("IDLE");
    try {
      const mark = client.mark();
      await client.prompt(`E2E WATCHDOG IDLE PATH ${readinessPath}`);
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "watchdog delegation", 60_000, mark));
      const waited = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "watchdog reply", 60_000, mark));
      assert.deepEqual(waited.items.map((item) => [item.requestId, item.state]), [[sent.correlationId, "answered"]]);
      await client.waitFor(assistantText("E2E COMPLETE"), "watchdog main completion", 30_000, mark);
      await client.waitForSettlement(mark);

      const readiness = JSON.parse(await readFile(readinessPath, "utf8")) as { startedMs: number; finishedMs: number };
      assert.ok(Number.isFinite(readiness.startedMs));
      assert.ok(Number.isFinite(readiness.finishedMs));
      assert.ok(readiness.finishedMs - readiness.startedMs >= 1_400, "real child crossed the 700ms idle interval");

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.some((agent: any) => agent.address === WORKER_ADDRESS && agent.state === "idle"),
        "with the watchdog worker idle",
      );
      const agent = registry.agents.find((candidate: any) => candidate.address === WORKER_ADDRESS);
      assert.equal(agent.failure, undefined);
      assert.ok(agent.sessionFile);
      const bash = correlatedBashResult(agent.sessionFile);
      assert.equal(bash.result.isError, false, `Bash ${bash.callId} should succeed`);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === sent.correlationId).length, 1);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps the absolute run deadline finite while built-in Bash is active", { timeout: 120_000 }, async () => {
    const { client, agentDir, readinessPath, sessionId } = await startScenario("RUN");
    try {
      const mark = client.mark();
      await client.prompt(`E2E WATCHDOG RUN PATH ${readinessPath}`);
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "run-timeout delegation", 60_000, mark));
      const waited = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "run-timeout waiter", 60_000, mark));
      assert.deepEqual(waited.items.map((item) => [item.requestId, item.state]), [[sent.correlationId, "failed"]]);

      const readiness = JSON.parse(await readFile(readinessPath, "utf8")) as { startedMs: number; finishedMs?: number };
      assert.ok(Number.isFinite(readiness.startedMs), "real Bash child started before the run deadline");
      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.some((agent: any) => agent.address === WORKER_ADDRESS
          && String(agent.failure ?? "").includes("LIFECYCLE_RUN_TIMEOUT")),
        "with an absolute run timeout",
      );
      const agent = registry.agents.find((candidate: any) => candidate.address === WORKER_ADDRESS);
      assert.match(agent.failure, /LIFECYCLE_RUN_TIMEOUT/);
      assert.doesNotMatch(agent.failure, /LIFECYCLE_IDLE_TIMEOUT/);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === sent.correlationId).length, 0);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
