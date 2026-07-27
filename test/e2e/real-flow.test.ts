/**
 * Real end-to-end suite: drives an actual `pi --mode rpc` process with the
 * extension under test and a deterministic scripted provider. The broker,
 * mail journal, registry, real SDK worker sessions, steering, and reply
 * collection all run for real; only the LLM is mocked, so no paid provider
 * calls are required.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const WORKER_ADDRESS = "scout.e2e@mock-e2e.com";

interface Started {
  client: PiRpcClient;
  agentDir: string;
  sessionId: string;
}

async function start(): Promise<Started> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-e2e-agent-"));
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, EXTENSION],
  });
  const state = await client.getState();
  assert.equal(state.success, true, client.stderr);
  const sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
  assert.ok(sessionId, "expected a session id in get_state");
  return { client, agentDir, sessionId: sessionId! };
}

function toolEnd(toolName: string, after = 0) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function assistantText(text: string) {
  return (line: RpcLine) => {
    if (line.type !== "message_end") return false;
    const message = line.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") return false;
    const content = message.content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => (part as { type?: string; text?: string }).type === "text"
      && String((part as { text?: string }).text ?? "").includes(text));
  };
}

function sendResult(line: RpcLine): any {
  return (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
}

function waitResult(line: RpcLine): { complete: boolean; timedOut: boolean; items: { state: string; requestId: string }[] } {
  const result = (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
  assert.ok(result, "wait_for_replies returned no result details");
  return result as { complete: boolean; timedOut: boolean; items: { state: string; requestId: string }[] };
}

async function readRegistry(agentDir: string, sessionId: string): Promise<any> {
  const raw = await readFile(join(agentDir, "subagents", sessionId, "registry.json"), "utf8");
  return JSON.parse(raw);
}

async function eventuallyRegistry(
  agentDir: string,
  sessionId: string,
  pred: (registry: any) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const registry = await readRegistry(agentDir, sessionId);
      last = registry;
      if (pred(registry)) return registry;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
  assert.fail(`Timed out waiting for registry ${description}: ${JSON.stringify(last)?.slice(0, 500)}`);
}

async function readJournal(agentDir: string, sessionId: string): Promise<any[]> {
  const raw = await readFile(join(agentDir, "subagents", sessionId, "mail.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("real end-to-end email flow", { concurrency: false }, () => {
  it("delegates to a spawned worker and collects its reply in one wait", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      await client.prompt("E2E DELEGATE");

      const send = await client.waitFor(toolEnd("send_email"), "main send_email completion");
      const sent = sendResult(send);
      assert.equal(sent.spawned, true);
      assert.equal(sent.recipientDisposition, "spawned");
      assert.equal(sent.envelope.to, WORKER_ADDRESS);
      assert.match(sent.expectedReplySubject, /^Re: \[mail_\S+\] Verify e2e mailbox$/);
      const requestId = sent.correlationId as string;

      // The widget integration publishes agent state while the worker runs.
      await client.waitFor(
        (line) => line.type === "extension_ui_request" && line.method === "setWidget"
          && line.widgetKey === "pi-email-subagent",
        "agent status widget",
      );

      const wait = await client.waitFor(toolEnd("wait_for_replies"), "collected reply", 120_000);
      const result = waitResult(wait);
      assert.equal(result.complete, true);
      assert.equal(result.timedOut, false);
      assert.deepEqual(result.items.map((item) => [item.requestId, item.state]), [[requestId, "answered"]]);

      await client.waitFor(assistantText("E2E COMPLETE"), "final assistant text");
      await client.waitForSettlement(client.mark() - 1);

      // Durable side effects: registry, journal, and worker session file.
      // Read them before close: shutdown intentionally flips idle agents to paused.
      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle" && candidate.agents[0].usage?.turns >= 2,
        "with an idle worker that completed turns",
      );
      assert.equal(registry.agents.length, 1);
      const agent = registry.agents[0];
      assert.equal(agent.address, WORKER_ADDRESS);
      assert.ok(agent.sessionFile, "worker session file recorded");
      await stat(agent.sessionFile);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      const answered = journal.filter((event) => event.type === "email.answered" && event.id === requestId);
      assert.equal(answered.length, 1, "request answered exactly once in the journal");
      const replyId = answered[0].replyId;
      assert.ok(journal.some((event) => event.type === "email.created" && event.email.id === replyId
        && event.email.from === WORKER_ADDRESS && event.email.kind === "reply"));
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reuses the identity, then stops and archives it", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      let mark = client.mark();
      await client.prompt("E2E DELEGATE");
      const first = sendResult(await client.waitFor(toolEnd("send_email"), "first send", 90_000, mark));
      assert.equal(first.spawned, true);
      let wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "first reply", 120_000, mark));
      assert.equal(wait.items[0]?.state, "answered");
      await client.waitForSettlement(client.mark() - 1);

      // Second delegation to the same address reuses the persistent identity.
      mark = client.mark();
      await client.prompt("E2E DELEGATE");
      const second = sendResult(await client.waitFor(toolEnd("send_email"), "second send", 90_000, mark));
      assert.equal(second.spawned, false);
      assert.equal(second.recipientDisposition, "reused");
      assert.notEqual(second.correlationId, first.correlationId);
      wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "second reply", 120_000, mark));
      assert.equal(wait.items.at(-1)?.state, "answered");
      await client.waitForSettlement(client.mark() - 1);

      // Lifecycle control through the main-only manage tool.
      mark = client.mark();
      await client.prompt("E2E STOP");
      const stopped = (await client.waitFor(toolEnd("manage_agent"), "stop result", 90_000, mark)).result as any;
      assert.equal(stopped.details.state, "stopped");
      await client.waitForSettlement(client.mark() - 1);

      mark = client.mark();
      await client.prompt("E2E ARCHIVE");
      const archived = (await client.waitFor(toolEnd("manage_agent"), "archive result", 90_000, mark)).result as any;
      assert.equal(archived.details.state, "archived");
      await client.waitForSettlement(client.mark() - 1);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "archived",
        "with the archived worker",
      );
      assert.equal(registry.agents.length, 1, "reuse never created a second identity");
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("steers high-priority mail into a genuinely busy worker", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      // The worker sleeps inside its first model stream, so it is truly
      // mid-run when the high-priority email arrives.
      let mark = client.mark();
      await client.prompt("E2E DELEGATE SLOW 4000 NOWAIT");
      const first = sendResult(await client.waitFor(toolEnd("send_email"), "slow task send", 90_000, mark));
      assert.equal(first.spawned, true);
      await client.waitFor(assistantText("E2E SENT"), "fire-and-forget turn end");
      await client.waitForSettlement(client.mark() - 1);

      mark = client.mark();
      await client.prompt("E2E DELEGATE HIGH");
      const high = sendResult(await client.waitFor(toolEnd("send_email"), "high-priority send", 90_000, mark));
      const highMark = mark;
      assert.equal(high.spawned, false);
      assert.equal(high.envelope.priority, "high");
      assert.equal(
        high.envelope.deliveryState,
        "delivered",
        "high-priority mail should be steered into the running worker immediately",
      );

      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "both replies", 120_000, highMark));
      assert.equal(wait.complete, true);
      const states = new Map(wait.items.map((item) => [item.requestId, item.state]));
      assert.equal(states.get(first.correlationId), "answered");
      assert.equal(states.get(high.correlationId), "answered");
      await client.waitFor(assistantText("E2E COMPLETE"), "final assistant text");
      await client.waitForSettlement(client.mark() - 1);
      assert.equal(await client.close(), 0, client.stderr);

      const registry = await readRegistry(agentDir, sessionId);
      assert.equal(registry.agents.length, 1);
      const journal = await readJournal(agentDir, sessionId);
      for (const id of [first.correlationId, high.correlationId]) {
        assert.equal(
          journal.filter((event) => event.type === "email.answered" && event.id === id).length,
          1,
          `request ${id} answered exactly once`,
        );
      }
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
