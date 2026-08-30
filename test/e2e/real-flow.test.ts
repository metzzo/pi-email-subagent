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
import { MailStore } from "../../src/mail-store.ts";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const MOCK_EXTENSION = resolve("test/e2e/helpers/mock-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const SHUTDOWN_ON_SETTLED_EXTENSION = resolve("test/e2e/helpers/shutdown-on-settled-extension.ts");
const WORKER_ADDRESS = "scout.e2e@mock-e2e.com";
const REVIEWER_ADDRESS = "reviewer.e2e@mock-e2e.com";

interface Started {
  client: PiRpcClient;
  agentDir: string;
  sessionId: string;
  sessionFile?: string;
}

async function start(options: {
  config?: Record<string, unknown>;
  persistSession?: boolean;
  beforeExtension?: string[];
} = {}): Promise<Started> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-e2e-agent-"));
  if (options.config) await writeFile(join(agentDir, "subagents.json"), JSON.stringify(options.config));
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: "mock-e2e/mock-e2e",
    extensions: [MOCK_EXTENSION, ...(options.beforeExtension ?? []), EXTENSION],
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

function waitResult(line: RpcLine): { complete: boolean; timedOut: boolean; items: { state: string; requestId: string; reply?: { id: string; message: string } }[] } {
  const result = (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
  assert.ok(result, "wait_for_replies returned no result details");
  return result as { complete: boolean; timedOut: boolean; items: { state: string; requestId: string; reply?: { id: string; message: string } }[] };
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

async function readSessionEntries(sessionFile: string): Promise<Array<Record<string, any>>> {
  return (await readFile(sessionFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function emailCustomEntries(entries: Array<Record<string, any>>, replyId?: string): Array<Record<string, any>> {
  return entries.filter((entry) => entry.type === "custom_message"
    && entry.customType === "pi-email-subagent.email"
    && (replyId === undefined || entry.details?.id === replyId));
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

  it("collects a pre-wait reply with no duplicate custom message through observed final settlement", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionFile } = await start({ persistSession: true });
    try {
      assert.ok(sessionFile, "persisted main session file");
      const mark = client.mark();
      await client.prompt("E2E DELEGATE LATE COLLECTOR");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "late-collector send", 90_000, mark));
      const requestId = sent.correlationId as string;
      const waited = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "late collector", 120_000, mark));
      const replyId = waited.items[0]?.reply?.id;
      assert.equal(waited.items[0]?.requestId, requestId);
      assert.equal(waited.items[0]?.state, "answered");
      assert.ok(replyId, "collected result carries the reply email ID");

      await client.waitFor(assistantText("E2E COMPLETE"), "late-collector final text", 90_000, mark);
      await client.waitForSettlement(mark);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));

      const entries = await readSessionEntries(sessionFile!);
      const collected = entries.filter((entry) => entry.type === "message"
        && entry.message?.role === "toolResult"
        && entry.message?.toolName === "wait_for_replies"
        && entry.message?.details?.result?.items?.some((item: any) => item.requestId === requestId && item.reply?.id === replyId));
      const duplicateCustomMessages = emailCustomEntries(entries, replyId);
      assert.equal(collected.length, 1, "the stable reply ID appears once in the wait tool result");
      assert.equal(duplicateCustomMessages.length, 0, "no duplicate custom message was observed through final settlement");
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("publishes old settlement before deferred ordinary delivery and detects its persisted custom entry", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionFile } = await start({ persistSession: true });
    try {
      assert.ok(sessionFile, "persisted main session file");
      const mark = client.mark();
      await client.prompt("E2E DELEGATE LATE COLLECTOR NOWAIT");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "deferred ordinary send", 90_000, mark));
      const requestId = sent.correlationId as string;
      const firstCompletion = await client.waitFor(assistantText("E2E SENT"), "pre-delivery main completion", 90_000, mark);
      const oldSettled = await client.waitForSettlement(mark, 90_000);
      const delivered = await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string; details?: { inReplyTo?: string } } | undefined)?.customType === "pi-email-subagent.email"
          && (line.message as { details?: { inReplyTo?: string } }).details?.inReplyTo === requestId,
        "deferred ordinary custom message",
        90_000,
        mark,
      );
      const deliveryIndex = client.events().indexOf(delivered);
      assert.ok(client.events().indexOf(firstCompletion) < client.events().indexOf(oldSettled));
      assert.ok(client.events().indexOf(oldSettled) < deliveryIndex, "the old public settled event precedes deferred delivery");
      const replyId = (delivered.message as { details?: { id?: string } }).details?.id;
      assert.ok(replyId);

      await client.waitFor(assistantText("E2E REPLY SEEN"), "ordinary delivery run", 90_000, deliveryIndex);
      const finalSettled = await client.waitFor(
        (line) => line.type === "agent_settled",
        "post-delivery final settled",
        90_000,
        deliveryIndex + 1,
      );
      assert.ok(client.events().indexOf(finalSettled) > deliveryIndex);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));

      const persisted = emailCustomEntries(await readSessionEntries(sessionFile!), replyId);
      assert.equal(persisted.length, 1, "the top-level custom_message parser detects known ordinary delivery");
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("cancels a pending settlement flush when real Pi requested shutdown wins", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId, sessionFile } = await start({
      persistSession: true,
      beforeExtension: [SHUTDOWN_ON_SETTLED_EXTENSION],
    });
    try {
      assert.ok(sessionFile, "persisted main session file");
      const mark = client.mark();
      await client.prompt("E2E DELEGATE LATE COLLECTOR NOWAIT");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "shutdown-race send", 90_000, mark));
      const requestId = sent.correlationId as string;
      assert.equal(await client.waitForExit(), 0, client.stderr);

      const store = new MailStore(join(agentDir, "subagents", sessionId, "mail.jsonl"));
      await store.init();
      const request = store.get(requestId);
      const reply = store.list().find((email) => email.inReplyTo === requestId);
      assert.ok(reply);
      assert.equal(reply.deliveryState, "queued");
      assert.equal(request?.replyReservedBy, reply.id);
      assert.equal(emailCustomEntries(await readSessionEntries(sessionFile!), reply.id).length, 0);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("steers a high correlated reply, ends a multi-ID wait partial, and omits the duplicate body", { timeout: 240_000 }, async () => {
    const { client, agentDir } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE MULTI BLOCKER");
      const sends = await client.collect(toolEnd("send_email"), 2, "multi-blocker sends", 90_000, mark);
      const sent = sends.map(sendResult);
      const highRequestId = sent.find((result) => result.envelope.to === WORKER_ADDRESS)?.correlationId as string;
      const slowRequestId = sent.find((result) => result.envelope.to === REVIEWER_ADDRESS)?.correlationId as string;
      assert.ok(highRequestId);
      assert.ok(slowRequestId);

      const waitEnd = await client.waitFor(toolEnd("wait_for_replies"), "high partial collector", 90_000, mark);
      const result = waitResult(waitEnd);
      assert.equal(result.complete, false);
      assert.equal(result.timedOut, false);
      const high = result.items.find((item) => item.requestId === highRequestId);
      const slow = result.items.find((item) => item.requestId === slowRequestId);
      assert.equal(high?.state, "answered");
      assert.equal(high?.reply, undefined);
      assert.equal(slow?.state, "pending");
      assert.doesNotMatch(toolText(waitEnd), /Worker result: virtual email tools/i);

      const custom = await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string; details?: { inReplyTo?: string } } | undefined)?.customType === "pi-email-subagent.email"
          && (line.message as { details?: { inReplyTo?: string } }).details?.inReplyTo === highRequestId,
        "high ordinary custom message",
        90_000,
        mark,
      );
      assert.match(String((custom.message as { details?: { message?: string } }).details?.message), /Worker result: virtual email tools/);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("wakes a collect:false multi-ID wait for ordinary high presentation without duplicating its body", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionFile } = await start({ persistSession: true });
    try {
      assert.ok(sessionFile, "persisted main session file");
      const mark = client.mark();
      await client.prompt("E2E DELEGATE MULTI BLOCKER COLLECT FALSE");
      const sends = await client.collect(toolEnd("send_email"), 2, "observing multi-blocker sends", 90_000, mark);
      const sent = sends.map(sendResult);
      const highRequestId = sent.find((result) => result.envelope.to === WORKER_ADDRESS)?.correlationId as string;
      const slowRequestId = sent.find((result) => result.envelope.to === REVIEWER_ADDRESS)?.correlationId as string;
      assert.ok(highRequestId);
      assert.ok(slowRequestId);

      const waitEnd = await client.waitFor(toolEnd("wait_for_replies"), "collect:false high partial wait", 90_000, mark);
      const result = waitResult(waitEnd);
      assert.equal(result.complete, false);
      assert.equal(result.timedOut, false);
      assert.equal(result.items.find((item) => item.requestId === highRequestId)?.reply, undefined);
      assert.equal(result.items.find((item) => item.requestId === slowRequestId)?.state, "pending");
      assert.doesNotMatch(toolText(waitEnd), /Worker result: virtual email tools/i);
      assert.match(toolText(waitEnd), /high-priority presentation can wake a multi-ID wait early/i);

      const custom = await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string; details?: { inReplyTo?: string } } | undefined)?.customType === "pi-email-subagent.email"
          && (line.message as { details?: { inReplyTo?: string } }).details?.inReplyTo === highRequestId,
        "collect:false high ordinary custom message",
        90_000,
        mark,
      );
      const replyId = (custom.message as { details?: { id?: string } }).details?.id;
      assert.ok(replyId);
      assert.match(String((custom.message as { details?: { message?: string } }).details?.message), /Worker result: virtual email tools/);
      await client.waitForSettlement(mark);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
      assert.equal(emailCustomEntries(await readSessionEntries(sessionFile!), replyId).length, 1);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("records scripted edit/write outcomes and keeps bash effects unverified", { timeout: 240_000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-email-work-ledger-e2e-"));
    const editPath = join(workspace, "edit.txt");
    const writePath = join(workspace, "write.txt");
    await writeFile(editPath, "before\n");
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt(`E2E DELEGATE WORK PATH ${editPath} WRITE ${writePath}`);
      await client.waitFor(assistantText("E2E COMPLETE"), "work delegation completion", 120_000, mark);
      await client.waitForSettlement(mark);
      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.some((agent: any) => agent.address === "worker.work-e2e@mock-e2e.com"
          && agent.work?.recent?.some((item: any) => item.kind === "edit" && item.status === "succeeded")
          && agent.work?.recent?.some((item: any) => item.kind === "edit" && item.status === "failed")
          && agent.work?.recent?.some((item: any) => item.kind === "write")),
        "with persisted edit/write work",
      );
      const agent = registry.agents.find((candidate: any) => candidate.address === "worker.work-e2e@mock-e2e.com");
      const edits = agent.work.recent.filter((item: any) => item.kind === "edit");
      const edit = edits.find((item: any) => item.status === "succeeded");
      const failedEdit = edits.find((item: any) => item.status === "failed");
      const write = agent.work.recent.find((item: any) => item.kind === "write");
      const shell = agent.work.recent.find((item: any) => item.kind === "shell");
      assert.equal(edit.status, "succeeded");
      assert.equal(edit.attribution, "explicit");
      assert.equal(edit.linesAdded, 1);
      assert.equal(edit.linesRemoved, 1);
      assert.equal(failedEdit.status, "failed");
      assert.equal(JSON.stringify(failedEdit).includes("SENTINEL"), false);
      assert.equal(write.status, "succeeded");
      assert.equal(write.attribution, "explicit");
      assert.equal(shell.status, "succeeded");
      assert.equal(shell.attribution, "unverified");
      assert.equal(agent.work.inspection.reads, 1);
      const confirmed = agent.work.recent.filter((item: any) => item.status === "succeeded" && item.attribution === "explicit");
      assert.equal(new Set(confirmed.map((item: any) => item.path)).size, 2);
      assert.equal(JSON.stringify(agent.work).includes("PRIVATE E2E WRITE BODY"), false);
      assert.equal(await readFile(editPath, "utf8"), "after\n");
      assert.equal(await readFile(writePath, "utf8"), "PRIVATE E2E WRITE BODY\n");
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
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
      await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle",
        "with the reused worker settled before lifecycle control",
      );

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

  it("previews and persists an xhigh effort override through the real tool and SDK worker", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      let mark = client.mark();
      await client.prompt("E2E INSPECT XHIGH");
      const prospective = (await client.waitFor(toolEnd("inspect_agent"), "xhigh prospective inspection", 90_000, mark))
        .result as any;
      assert.equal(prospective.details.inspection.exists, false);
      assert.equal(prospective.details.inspection.effort, "xhigh");
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E DELEGATE XHIGH");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "xhigh send", 90_000, mark));
      assert.equal(sent.spawned, true);
      assert.equal(sent.envelope.effortIntent, "xhigh");
      assert.equal(sent.recipientEffort, "xhigh");
      await client.waitFor(toolEnd("wait_for_replies"), "xhigh worker reply", 120_000, mark);
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle",
        "with an idle xhigh worker",
      );
      assert.equal(registry.agents[0]?.effort, "xhigh");
      const journal = await readJournal(agentDir, sessionId);
      const created = journal.find((event) => event.type === "email.created" && event.email.id === sent.correlationId);
      assert.equal(created?.email?.effortIntent, "xhigh");
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("settles after one timed-out wait and later handles the exact reply in an automatic main turn", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE SLOW 3000 WAIT TIMEOUT");
      const sendEnd = await client.waitFor(toolEnd("send_email"), "timeout scenario send", 90_000, mark);
      const sent = sendResult(sendEnd);
      const requestId = sent.correlationId as string;
      assert.match(requestId, /^mail_/);

      const waitEnd = await client.waitFor(toolEnd("wait_for_replies"), "one timed-out wait", 90_000, mark);
      const result = waitResult(waitEnd);
      assert.equal(result.complete, false);
      assert.equal(result.timedOut, true);
      assert.deepEqual(result.items.map((item) => [item.requestId, item.state]), [[requestId, "pending"]]);
      assert.match(toolText(waitEnd), /pending requests remain correlated/i);
      assert.match(toolText(waitEnd), /low-priority reply.*main is busy.*broker-queued.*agent_settled/is);
      assert.match(toolText(waitEnd), /sendMessage.*no durable append acknowledgement/is);
      assert.match(toolText(waitEnd), /no immediate keepalive rejoin/i);

      const mainCompletion = await client.waitFor(
        assistantText("E2E WAIT WINDOW ENDED"),
        "main completion after the finite wait",
        90_000,
        mark,
      );
      const completionIndex = client.events().indexOf(mainCompletion);
      const startsBeforeCompletion = client.events().slice(mark, completionIndex + 1).filter((line) =>
        line.type === "tool_execution_start" && line.toolName === "wait_for_replies");
      assert.equal(startsBeforeCompletion.length, 1, "the settled main turn issued one wait, not an immediate rejoin");
      const waitStart = startsBeforeCompletion[0]!;
      assert.deepEqual((waitStart.args as { request_ids?: string[] }).request_ids, [requestId]);
      assert.equal(waitStart.toolCallId, waitEnd.toolCallId, "canonical start/end events identify the same wait call");

      const delivered = await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string } | undefined)?.customType === "pi-email-subagent.email",
        "late correlated reply delivery",
        120_000,
        mark,
      );
      const deliveryIndex = client.events().indexOf(delivered);
      assert.ok(deliveryIndex > completionIndex, "late reply arrives after the first main turn completed");
      const envelope = (delivered.message as { details?: any }).details;
      assert.equal(envelope.kind, "reply");
      assert.equal(envelope.from, WORKER_ADDRESS);
      assert.equal(envelope.inReplyTo, requestId);
      const waitsBeforeDelivery = client.events().slice(mark, deliveryIndex).filter((line) =>
        line.type === "tool_execution_start" && line.toolName === "wait_for_replies");
      assert.equal(waitsBeforeDelivery.length, 1, "no overlapping keepalive-style rejoin precedes late delivery");

      await client.waitFor(assistantText("E2E REPLY SEEN"), "automatic late-reply main run", 90_000, mark);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      const answered = journal.filter((event) => event.type === "email.answered" && event.id === requestId);
      assert.equal(answered.length, 1, "the parsed journal has one authoritative answer transition");
      const replyId = answered[0]?.replyId;
      assert.equal(journal.filter((event) => event.type === "email.created"
        && event.email?.id === replyId && event.email?.inReplyTo === requestId).length, 1);
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

  it("rejects nested delegation by default without creating a child obligation", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE NESTED");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "default-disabled parent send", 90_000, mark));
      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "default-disabled parent failure", 120_000, mark));
      assert.deepEqual(wait.items.map((item) => [item.requestId, item.state]), [[sent.correlationId, "failed"]]);
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.some((agent: any) => agent.address === WORKER_ADDRESS && agent.state === "failed"),
        "with the default-disabled parent failed on its open upstream obligation",
      );
      assert.equal(registry.agents.find((agent: any) => agent.address === WORKER_ADDRESS).canSpawn, false);
      assert.equal(registry.agents.some((agent: any) => agent.address === REVIEWER_ADDRESS), false);
      const journal = await readJournal(agentDir, sessionId);
      const requests = journal.filter((event) => event.type === "email.created" && event.email?.kind === "request");
      assert.deepEqual(requests.map((event) => event.email.id), [sent.correlationId]);
      assert.equal(journal.some((event) => event.type === "email.answered" && event.id === sent.correlationId), false);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves a real worker request unanswered when it omits send_email", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E DELEGATE IGNORE");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "ignored send", 90_000, mark));
      const wait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "failed unanswered wait", 120_000, mark));
      assert.equal(wait.complete, true);
      assert.equal(wait.items[0]?.state, "failed");
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "failed" && Boolean(candidate.agents[0].sessionFile),
        "with the enforcement-exhausted worker",
      );
      const transcript = await readFile(registry.agents[0].sessionFile, "utf8");
      assert.match(transcript, /mailbox-enforcement/);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.some((event) => event.type === "email.answered" && event.id === sent.correlationId), false);
      assert.equal(journal.some((event) => event.type === "email.reply_reserved" && event.id === sent.correlationId), false);
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

  it("recovers identity capacity only through explicit stop-cancel-archive actions", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start({ config: { maxAgents: 1, maxConcurrent: 1 } });
    try {
      const mark = client.mark();
      await client.prompt("E2E CAPACITY RECOVERY");
      const firstSendEnd = await client.waitFor(toolEnd("send_email"), "first capacity send", 30_000, mark);
      assert.equal(isErrorResult(firstSendEnd), false);
      const first = sendResult(firstSendEnd);
      const firstId = first.correlationId as string;
      assert.match(firstId, /^mail_/);

      const rejected = await client.waitFor(
        (line) => toolEnd("send_email")(line) && line.isError === true,
        "pre-accept identity-capacity rejection",
        30_000,
        mark,
      );
      assert.match(toolText(rejected), /identity capacity.*1\/1.*activation leases/i);
      assert.match(toolText(rejected), /run concurrency.*1\/1/i);
      assert.match(toolText(rejected), /stopping.*does not free.*identity lease/i);
      assert.doesNotMatch(toolText(rejected), /scout\.e2e|Capacity owner obligation|Keep this exact request open/i);
      const journalAfterReject = await readJournal(agentDir, sessionId);
      assert.equal(journalAfterReject.filter((event) => event.type === "email.created").length, 1);

      await client.waitFor(assistantText("E2E CAPACITY RECOVERED"), "explicit recovery completion", 120_000, mark);
      await client.waitForSettlement(mark);
      const starts = client.events().slice(mark).filter((line) => line.type === "tool_execution_start"
        && ["send_email", "manage_agent", "cancel_request"].includes(String(line.toolName)));
      assert.deepEqual(starts.map((line) => [line.toolName, (line.args as any).action ?? (line.args as any).to ?? "cancel"]), [
        ["send_email", WORKER_ADDRESS],
        ["send_email", REVIEWER_ADDRESS],
        ["manage_agent", "archive"],
        ["manage_agent", "stop"],
        ["cancel_request", "cancel"],
        ["manage_agent", "archive"],
        ["send_email", REVIEWER_ADDRESS],
      ]);
      const cancellationStart = starts.find((line) => line.toolName === "cancel_request")!;
      assert.equal((cancellationStart.args as any).request_id, firstId);
      assert.match(String((cancellationStart.args as any).reason), /explicitly abandoned/i);

      const ends = client.events().slice(mark).filter((line) => line.type === "tool_execution_end"
        && ["send_email", "manage_agent", "cancel_request"].includes(String(line.toolName)));
      const archiveEnds = ends.filter((line) => line.toolName === "manage_agent");
      assert.equal(archiveEnds[0]?.isError, true, "archive refuses active/open work");
      assert.equal(archiveEnds[1]?.isError, false, "stop is an explicit separate action");
      assert.equal(archiveEnds[2]?.isError, false, "archive succeeds only after exact cancellation");
      const stoppedDetails = (archiveEnds[1]?.result as any)?.details;
      assert.equal(stoppedDetails.holdsActivationLease, true);
      assert.deepEqual(stoppedDetails.capacity, {
        identitiesUsed: 1, identitiesLimit: 1, runSlotsUsed: 0, runSlotsLimit: 1,
      });
      const archivedDetails = (archiveEnds[2]?.result as any)?.details;
      assert.equal(archivedDetails.holdsActivationLease, false);
      assert.equal(archivedDetails.capacity.identitiesUsed, 0);
      const sendEnds = ends.filter((line) => line.toolName === "send_email");
      assert.deepEqual(sendEnds.map((line) => line.isError === true), [false, true, false]);
      const retry = sendResult(sendEnds[2]!);
      assert.equal(retry.spawned, true);
      assert.notEqual(retry.correlationId, firstId);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.created" && event.email?.kind === "request").length, 2, "rejected send created no request envelope");
      assert.equal(journal.filter((event) => event.type === "email.cancelled" && event.id === firstId).length, 1);
      const firstCreated = journal.find((event) => event.type === "email.created" && event.email?.id === firstId)?.email;
      assert.equal(firstCreated?.answeredAt, undefined);
      assert.equal(journal.some((event) => event.type === "email.answered" && event.id === firstId), false);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects archival until a queued obligation is explicitly cancelled", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
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

      mark = client.mark();
      await client.prompt("E2E CANCEL");
      const cancellation = await client.waitFor(toolEnd("cancel_request"), "audited cancellation", 90_000, mark);
      assert.equal(isErrorResult(cancellation), false);
      assert.match(toolText(cancellation), new RegExp(queued.correlationId));
      assert.match(toolText(cancellation), /intentionally abandoned/i);
      await client.waitForSettlement(mark);

      mark = client.mark();
      await client.prompt("E2E ARCHIVE");
      const archived = await client.waitFor(toolEnd("manage_agent"), "archive after cancellation", 90_000, mark);
      assert.equal(isErrorResult(archived), false);
      await client.waitForSettlement(mark);
      assert.equal(await client.close(), 0, client.stderr);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.cancelled" && event.id === queued.correlationId).length, 1);
      const registry = await readRegistry(agentDir, sessionId);
      assert.equal(registry.agents.find((agent: any) => agent.address === WORKER_ADDRESS)?.state, "archived");
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
