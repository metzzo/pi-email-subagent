/**
 * Real end-to-end suite: drives an actual `pi --mode rpc` process with the
 * extension under test and a deterministic scripted provider. The broker,
 * mail journal, registry, real SDK worker sessions, steering, and reply
 * collection all run for real; only the LLM is mocked, so no paid provider
 * calls are required.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const WORKER_ADDRESS = "scout.e2e@mock-e2e.com";
const REVIEWER_ADDRESS = "reviewer.e2e@mock-e2e.com";

interface Started {
  client: PiRpcClient;
  agentDir: string;
  sessionId: string;
  sessionFile?: string;
}

async function start(options: { config?: Record<string, unknown>; persistSession?: boolean } = {}): Promise<Started> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-e2e-agent-"));
  if (options.config) await writeFile(join(agentDir, "subagents.json"), JSON.stringify(options.config));
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, EXTENSION],
    ...(options.persistSession ? { persistSession: true } : {}),
  });
  const state = await client.getState();
  assert.equal(state.success, true, client.stderr);
  const data = state.data as { sessionId?: string; sessionFile?: string } | undefined;
  assert.ok(data?.sessionId, "expected a session id in get_state");
  return { client, agentDir, sessionId: data.sessionId, ...(data.sessionFile ? { sessionFile: data.sessionFile } : {}) };
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

function isErrorResult(line: RpcLine): boolean {
  // Pi marks thrown tool failures on the lifecycle event itself. A custom
  // `result.isError` property is ignored by the native execution contract.
  return line.isError === true;
}

function toolText(line: RpcLine): string {
  const content = (line.result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}

describe("real end-to-end email flow", { concurrency: false }, () => {
  it("delegates to a spawned worker and collects its reply in one wait", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE");

      const send = await client.waitFor(toolEnd("send_email"), "main send_email completion", 90_000, mark);
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
      await client.waitForSettlement(mark);

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
      await client.waitForSettlement(mark);

      // Second delegation to the same address reuses the persistent identity.
      mark = client.mark();
      await client.prompt("E2E DELEGATE");
      const second = sendResult(await client.waitFor(toolEnd("send_email"), "second send", 90_000, mark));
      assert.equal(second.spawned, false);
      assert.equal(second.recipientDisposition, "reused");
      assert.notEqual(second.correlationId, first.correlationId);
      wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "second reply", 120_000, mark));
      assert.equal(wait.items.at(-1)?.state, "answered");
      await client.waitForSettlement(mark);

      // Lifecycle control through the main-only manage tool.
      mark = client.mark();
      await client.prompt("E2E STOP");
      const stopped = (await client.waitFor(toolEnd("manage_agent"), "stop result", 90_000, mark)).result as any;
      assert.equal(stopped.details.state, "stopped");
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E ARCHIVE");
      const archived = (await client.waitFor(toolEnd("manage_agent"), "archive result", 90_000, mark)).result as any;
      assert.equal(archived.details.state, "archived");
      await client.waitForSettlement(mark);

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
      await client.waitForSettlement(mark);

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
      await client.waitForSettlement(mark);
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

  it("rejects invalid mail with errors and no side effects", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E SEND INVALID NOWAIT");
      const results = await client.collect(toolEnd("send_email"), 3, "three rejected sends", 90_000, mark);
      for (const result of results) assert.equal(isErrorResult(result), true, toolText(result));
      const errors = results.map(toolText).join("\n");
      assert.match(errors, /exactly one "@"|must contain exactly one dot|Invalid subagent name/);
      assert.match(errors, /yourself is not supported/);
      assert.match(errors, /unknown email mail_0000_fake|has not been delivered|does not require an answer/);
      await client.waitFor(assistantText("E2E SENT"), "turn completion", 90_000, mark);
      await client.waitForSettlement(mark);

      const coordinationMark = client.mark();
      await client.prompt("E2E TOOL ERRORS");
      const coordinationErrors = await client.collect(
        (line) => line.type === "tool_execution_end"
          && ["inspect_agent", "wait_for_replies", "manage_agent"].includes(String(line.toolName)),
        3,
        "three native coordination-tool errors",
        90_000,
        coordinationMark,
      );
      for (const result of coordinationErrors) {
        assert.equal(result.isError, true, `${result.toolName}: ${toolText(result)}`);
      }
      await client.waitForSettlement(coordinationMark);
      assert.equal(await client.close(), 0, client.stderr);

      const registry = await readRegistry(agentDir, sessionId);
      assert.equal(registry.agents.length, 0, "invalid mail must not spawn identities");
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("previews capability with inspect_agent before and after spawning", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      let mark = client.mark();
      await client.prompt("E2E INSPECT");
      const prospective = (await client.waitFor(toolEnd("inspect_agent"), "prospective inspection", 90_000, mark))
        .result as any;
      assert.equal(prospective.details.inspection.exists, false);
      assert.equal(prospective.details.inspection.wouldSpawn, true);
      assert.equal(prospective.details.inspection.state, "new");
      assert.equal(prospective.details.inspection.writable, false);
      assert.deepEqual(prospective.details.inspection.tools, ["read", "grep", "find", "ls", "send_email", "fetch_emails"]);
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E DELEGATE");
      await client.waitFor(toolEnd("wait_for_replies"), "reply", 120_000, mark);
      await client.waitForSettlement(mark);
      // Reply collection can precede the worker's own settle; wait for idle.
      await eventuallyRegistry(agentDir, sessionId, (candidate) => candidate.agents?.[0]?.state === "idle", "with the idle worker");

      mark = client.mark();
      await client.prompt("E2E INSPECT");
      const existing = (await client.waitFor(toolEnd("inspect_agent"), "existing inspection", 90_000, mark))
        .result as any;
      assert.equal(existing.details.inspection.exists, true);
      assert.equal(existing.details.inspection.wouldSpawn, false);
      assert.equal(existing.details.inspection.state, "idle");
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("delivers an uncollected reply as an ordinary main mail turn", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE NOWAIT");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "send", 90_000, mark));
      // Note: no settlement wait here — agent_settled only fires at full
      // quiescence, which would consume the reply turn we assert on below.
      await client.waitFor(assistantText("E2E SENT"), "fire-and-forget turn end", 90_000, mark);

      // Without a collector, the worker's reply arrives as a displayed custom
      // email message that triggers a main turn.
      const delivered = await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string } | undefined)?.customType === "pi-email-subagent.email",
        "delivered reply message",
        120_000,
        mark,
      );
      const envelope = (delivered.message as { details?: any }).details;
      assert.equal(envelope.kind, "reply");
      assert.equal(envelope.from, WORKER_ADDRESS);
      assert.equal(envelope.inReplyTo, sent.correlationId);
      // The reply turn can begin immediately after message_start; search from
      // the scenario mark rather than taking a new mark after that boundary.
      await client.waitFor(assistantText("E2E REPLY SEEN"), "reply turn", 90_000, mark);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(
        journal.filter((event) => event.type === "email.answered" && event.id === sent.correlationId).length,
        1,
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fans out to two agents in parallel and collects both replies", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE BOTH");
      const sends = (await client.collect(toolEnd("send_email"), 2, "two parallel sends", 90_000, mark))
        .map(sendResult);
      assert.deepEqual(sends.map((sent) => sent.spawned).sort(), [true, true]);
      assert.deepEqual(
        sends.map((sent) => sent.envelope.to).sort(),
        [REVIEWER_ADDRESS, WORKER_ADDRESS].sort(),
      );

      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "both replies", 120_000, mark));
      assert.equal(wait.complete, true);
      assert.equal(wait.items.length, 2);
      assert.deepEqual(wait.items.map((item) => item.state).sort(), ["answered", "answered"]);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const registry = await readRegistry(agentDir, sessionId);
      assert.equal(registry.agents.length, 2);
      assert.deepEqual(
        registry.agents.map((agent: any) => agent.address).sort(),
        [REVIEWER_ADDRESS, WORKER_ADDRESS].sort(),
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("queues overflow work when maxConcurrent is one", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start({ config: { maxConcurrent: 1 } });
    try {
      let mark = client.mark();
      await client.prompt("E2E DELEGATE SLOW 3000 NOWAIT");
      const first = sendResult(await client.waitFor(toolEnd("send_email"), "first send", 90_000, mark));
      assert.equal(first.spawned, true);
      await client.waitFor(assistantText("E2E SENT"), "first turn end", 90_000, mark);
      await client.waitForSettlement(mark);

      // Worker one is genuinely mid-run (sleeping); worker two must queue.
      mark = client.mark();
      await client.prompt("E2E DELEGATE REVIEWER SLOW 1000");
      const second = sendResult(await client.waitFor(toolEnd("send_email"), "queued send", 90_000, mark));
      assert.equal(second.envelope.to, REVIEWER_ADDRESS);
      assert.equal(second.envelope.deliveryState, "queued");
      await client.waitFor(
        (line) => line.type === "extension_ui_request" && line.method === "setWidget"
          && Array.isArray(line.widgetLines) && (line.widgetLines as string[]).some((text) => text.includes("1 queued")),
        "queued worker widget",
        30_000,
        mark,
      );

      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "both replies", 120_000, mark));
      assert.equal(wait.complete, true);
      assert.deepEqual(wait.items.map((item) => item.state).sort(), ["answered", "answered"]);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      for (const id of [first.correlationId, second.correlationId]) {
        assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === id).length, 1);
      }
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("enforces an ignored obligation with a real reminder turn", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE IGNORE");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "ignored send", 90_000, mark));
      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "enforced reply", 120_000, mark));
      assert.equal(wait.complete, true);
      assert.equal(wait.items[0]?.state, "answered");
      await client.waitForSettlement(mark);

      // The worker's persisted transcript must show the enforcement reminder.
      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle" && Boolean(candidate.agents[0].sessionFile),
        "with the idle worker",
      );
      const transcript = await readFile(registry.agents[0].sessionFile, "utf8");
      assert.match(transcript, /mailbox-enforcement/);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(
        journal.filter((event) => event.type === "email.answered" && event.id === sent.correlationId).length,
        1,
        "exactly one answer despite the initial silence",
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("surfaces a terminal worker failure to the waiter and the registry", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE CRASH");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "doomed send", 90_000, mark));
      assert.equal(sent.spawned, true);

      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "failed wait", 120_000, mark));
      assert.equal(wait.complete, true);
      assert.equal(wait.items[0]?.state, "failed");

      // The failure is also pushed to main as a high-visibility alert turn.
      await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string } | undefined)?.customType === "pi-email-subagent.alert",
        "failure alert message",
        90_000,
        mark,
      );
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "failed",
        "with the failed worker",
      );
      assert.match(registry.agents[0].failure ?? "", /Simulated provider failure/);
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("enforces the per-sender rate limit across parallel sends", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start({ config: { maxMailsPerSenderPerMinute: 3 } });
    try {
      const mark = client.mark();
      await client.prompt("E2E RATE NOWAIT");
      const results = await client.collect(toolEnd("send_email"), 4, "four rate-probe sends", 90_000, mark);
      const rejected = results.filter(isErrorResult);
      const accepted = results.filter((line) => !isErrorResult(line));
      assert.equal(rejected.length, 1, results.map(toolText).join("\n---\n"));
      assert.equal(accepted.length, 3);
      assert.match(toolText(rejected[0]!), /rate limit/i);
      await client.waitFor(assistantText("E2E SENT"), "turn completion", 90_000, mark);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const registry = await readRegistry(agentDir, sessionId);
      assert.equal(registry.agents.length, 3, "only the accepted sends spawn identities");
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects archival while queued obligations remain", { timeout: 240_000 }, async () => {
    const { client, agentDir } = await start();
    try {
      let mark = client.mark();
      await client.prompt("E2E DELEGATE");
      await client.waitFor(toolEnd("wait_for_replies"), "reply", 120_000, mark);
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E STOP");
      await client.waitFor(toolEnd("manage_agent"), "stop", 90_000, mark);
      await client.waitForSettlement(mark);

      // Mail to the stopped agent is accepted but stays queued.
      mark = client.mark();
      await client.prompt("E2E DELEGATE NOWAIT");
      const queued = sendResult(await client.waitFor(toolEnd("send_email"), "queued send", 90_000, mark));
      assert.equal(queued.recipientDisposition, "stopped");
      assert.equal(queued.envelope.deliveryState, "queued");
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E ARCHIVE");
      const archive = await client.waitFor(toolEnd("manage_agent"), "archive rejection", 90_000, mark);
      assert.equal(isErrorResult(archive), true);
      assert.match(toolText(archive), /queued mail|unanswered obligations|cannot be archived/i);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("restores agents across a real process restart", { timeout: 300_000 }, async () => {
    const first = await start({ persistSession: true });
    let createdAt: string;
    let firstRequestId: string;
    try {
      assert.ok(first.sessionFile, "persisted main session file");
      const mark = first.client.mark();
      await first.client.prompt("E2E DELEGATE");
      const sent = sendResult(await first.client.waitFor(toolEnd("send_email"), "first send", 90_000, mark));
      firstRequestId = sent.correlationId;
      const wait = waitResult(await first.client.waitFor(toolEnd("wait_for_replies"), "first reply", 120_000, mark));
      assert.equal(wait.items[0]?.state, "answered");
      await first.client.waitForSettlement(mark);
      const registry = await eventuallyRegistry(
        first.agentDir,
        first.sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle",
        "with the idle worker",
      );
      createdAt = registry.agents[0].createdAt;
      assert.equal(await first.client.close(), 0, first.client.stderr);
    } finally {
      await first.client.close().catch(() => undefined);
    }

    // Relaunch against the same agent dir and resume the persisted session:
    // the broker namespace is keyed by session id, so the whole mailbox and
    // registry restore in the new process.
    const resumed = PiRpcClient.launch({
      cwd: process.cwd(),
      agentDir: first.agentDir,
      model: "mock-e2e/mock-e2e",
      extensions: [MOCK_EXTENSION, EXTENSION],
      persistSession: true,
    });
    try {
      await resumed.getState();
      await resumed.switchSession(first.sessionFile!);
      const state = await resumed.getState();
      assert.equal((state.data as { sessionId?: string }).sessionId, first.sessionId);

      // Wait for the broker to restore the worker before prompting.
      await eventuallyRegistry(
        first.agentDir,
        first.sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle",
        "with the restored worker",
        60_000,
      );

      const mark = resumed.mark();
      await resumed.prompt("E2E DELEGATE");
      const sent = sendResult(await resumed.waitFor(toolEnd("send_email"), "post-restart send", 90_000, mark));
      assert.equal(sent.spawned, false);
      assert.equal(sent.recipientDisposition, "reused");
      assert.notEqual(sent.correlationId, firstRequestId);
      const wait = waitResult(await resumed.waitFor(toolEnd("wait_for_replies"), "post-restart reply", 120_000, mark));
      assert.equal(wait.items.at(-1)?.state, "answered");
      await resumed.waitForSettlement(mark);
      assert.equal(await resumed.close(), 0, resumed.stderr);

      const registry = await readRegistry(first.agentDir, first.sessionId);
      assert.equal(registry.agents.length, 1, "restart never created a second identity");
      assert.equal(registry.agents[0].createdAt, createdAt, "identity survived the restart");
      const journal = await readJournal(first.agentDir, first.sessionId);
      for (const id of [firstRequestId, sent.correlationId]) {
        assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === id).length, 1);
      }
    } finally {
      await resumed.close().catch(() => undefined);
      await rm(first.agentDir, { recursive: true, force: true });
    }
  });
});
