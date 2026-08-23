import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const PROVIDER_EXTENSION = resolve("test/e2e/helpers/retry-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const MODEL = "mock-provider-retry/mock-provider-retry";
const WORKER_ADDRESS = "worker.provider-retry@mock-provider-retry.com";

interface Started {
  client: PiRpcClient;
  agentDir: string;
  sessionId: string;
}

async function start(): Promise<Started> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-provider-retry-e2e-"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 5,
      provider: { maxRetries: 0, maxRetryDelayMs: 1_000 },
    },
    transport: "sse",
    httpIdleTimeoutMs: 5_000,
    websocketConnectTimeoutMs: 2_000,
  }));
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: MODEL,
    extensions: [PROVIDER_EXTENSION, EXTENSION],
  });
  const state = await client.getState();
  assert.equal(state.success, true, client.stderr);
  const sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
  assert.ok(sessionId);
  return { client, agentDir, sessionId };
}

function toolEnd(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function toolStart(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_start" && line.toolName === toolName;
}

function sendResult(line: RpcLine): any {
  return (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
}

function waitResult(line: RpcLine): any {
  return (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
}

function messageText(line: RpcLine): string {
  const message = line.message as { content?: unknown } | undefined;
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

async function readRegistry(agentDir: string, sessionId: string): Promise<any> {
  return JSON.parse(await readFile(join(agentDir, "subagents", sessionId, "registry.json"), "utf8"));
}

async function eventuallyRegistry(
  agentDir: string,
  sessionId: string,
  predicate: (registry: any) => boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const registry = await readRegistry(agentDir, sessionId);
      last = registry;
      if (predicate(registry)) return registry;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  assert.fail(`Timed out waiting for registry ${description}: ${JSON.stringify(last)?.slice(0, 500)}`);
}

async function readJournal(agentDir: string, sessionId: string): Promise<any[]> {
  const raw = await readFile(join(agentDir, "subagents", sessionId, "mail.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function activeSessionMessages(sessionFile: string): any[] {
  return SessionManager.open(sessionFile).getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function retryActivity(record: any): Array<{ kind: string; summary: string }> {
  return (record.activity as Array<{ kind: string; summary: string }>)
    .filter((item) => item.summary.startsWith("Provider retry"))
    .map(({ kind, summary }) => ({ kind, summary }));
}

function customFailureAlerts(events: readonly RpcLine[], after: number): RpcLine[] {
  return events.slice(after).filter((line) => line.type === "message_start"
    && (line.message as { customType?: string } | undefined)?.customType === "pi-email-subagent.alert");
}

describe("real Pi provider retry resilience", { concurrency: false }, () => {
  it("recovers through Pi retry activity without a terminal alert or a new envelope", { timeout: 240_000 }, async () => {
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt("E2E PROVIDER RECOVER");
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "retry scenario send", 90_000, mark));
      const requestId = sent.correlationId as string;
      const waited = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "recovered reply", 120_000, mark));
      assert.deepEqual(waited.items.map((item: any) => [item.requestId, item.state]), [[requestId, "answered"]]);
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle" && retryActivity(candidate.agents[0]).length === 2,
        "with settled retry recovery activity",
      );
      const record = registry.agents[0];
      assert.equal(record.address, WORKER_ADDRESS);
      assert.equal(record.failure, undefined);
      assert.deepEqual(retryActivity(record), [
        { kind: "status", summary: "Provider retry 1/1 scheduled in 5ms: WebSocket error: deterministic recoverable attempt" },
        { kind: "status", summary: "Provider retry recovered after attempt 1" },
      ]);
      assert.equal(customFailureAlerts(client.events(), mark).length, 0);

      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.created" && event.email?.kind === "request").length, 1);
      assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === requestId).length, 1);
      const messages = activeSessionMessages(record.sessionFile);
      assert.equal(messages.filter((message) => message.role === "assistant" && message.stopReason === "error"
        && /WebSocket error/.test(message.errorMessage ?? "")).length, 1);
      assert.equal(messages.filter((message) => message.role === "user").length, 1, "Pi retry creates no extension prompt");
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("retries the provider turn after one completed write without replaying the effect", { timeout: 240_000 }, async () => {
    const effectDir = await mkdtemp(join(tmpdir(), "pi-email-provider-effect-"));
    const effectPath = join(effectDir, "effect.txt");
    const { client, agentDir, sessionId } = await start();
    try {
      const mark = client.mark();
      await client.prompt(`E2E PROVIDER TOOL RECOVER PATH ${effectPath}`);
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "tool retry send", 90_000, mark));
      const waited = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "tool retry reply", 120_000, mark));
      assert.equal(waited.items[0]?.requestId, sent.correlationId);
      assert.equal(waited.items[0]?.state, "answered");
      await client.waitForSettlement(mark);

      const registry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle" && retryActivity(candidate.agents[0]).length === 2,
        "with one-effect retry recovery",
      );
      const record = registry.agents[0];
      assert.equal(await readFile(effectPath, "utf8"), "effect occurred exactly once\n");
      const messages = activeSessionMessages(record.sessionFile);
      const writeCalls = messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === "toolCall" && part.name === "write")
        : []);
      const writeResults = messages.filter((message) => message.role === "toolResult" && message.toolName === "write");
      assert.equal(writeCalls.length, 1);
      assert.equal(writeResults.length, 1);
      assert.equal(writeResults[0]?.toolCallId, writeCalls[0]?.id);
      assert.equal(customFailureAlerts(client.events(), mark).length, 0);
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
      await rm(effectDir, { recursive: true, force: true });
    }
  });

  it("keeps an exhausted obligation open and recovers only after explicit same-identity restart", { timeout: 300_000 }, async () => {
    const effectDir = await mkdtemp(join(tmpdir(), "pi-email-provider-exhaust-"));
    const effectPath = join(effectDir, "effect.txt");
    const { client, agentDir, sessionId } = await start();
    try {
      let mark = client.mark();
      await client.prompt(`E2E PROVIDER EXHAUST PATH ${effectPath}`);
      const sent = sendResult(await client.waitFor(toolEnd("send_email"), "exhausted retry send", 90_000, mark));
      const requestId = sent.correlationId as string;
      await client.waitFor(
        (line) => line.type === "message_start"
          && (line.message as { customType?: string } | undefined)?.customType === "pi-email-subagent.alert",
        "terminal failure alert",
        120_000,
        mark,
      );
      await client.waitForSettlement(mark);

      const failedRegistry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "failed",
        "with terminal retry exhaustion",
      );
      const failed = failedRegistry.agents[0];
      assert.match(failed.failure ?? "", /fetch failed: deterministic exhausted attempt 2/);
      assert.deepEqual(retryActivity(failed), [
        { kind: "status", summary: "Provider retry 1/1 scheduled in 5ms: fetch failed: deterministic exhausted attempt 1" },
        { kind: "error", summary: "Provider retry ended after attempt 1: fetch failed: deterministic exhausted attempt 2" },
      ]);
      assert.equal(failed.work.recent.filter((item: any) => item.toolName === "write").length, 1);
      assert.equal(await readFile(effectPath, "utf8"), "terminal attempt effect occurred once\n");
      const alerts = customFailureAlerts(client.events(), mark);
      assert.equal(alerts.length, 1);
      const alert = messageText(alerts[0]!);
      assert.match(alert, /terminal worker run failure.*external or unclear/is);
      assert.match(alert, /1 delivered request remains unanswered/i);
      assert.match(alert, /current batch includes mutation\/shell\/custom work.*effects may exist/is);
      assert.match(alert, /explicit same-identity restart/i);
      assert.equal(client.events().slice(mark).filter(toolStart("manage_agent")).length, 0, "no automatic extension restart");

      const beforeJournal = await readJournal(agentDir, sessionId);
      assert.equal(beforeJournal.filter((event) => event.type === "email.created" && event.email?.id === requestId).length, 1);
      assert.equal(beforeJournal.some((event) => event.type === "email.answered" && event.id === requestId), false);
      const beforeMessages = activeSessionMessages(failed.sessionFile);
      assert.equal(beforeMessages.filter((message) => message.role === "user").length, 1, "agent retries add no prompt");
      assert.equal(beforeMessages.filter((message) => message.role === "assistant" && message.stopReason === "error").length, 2);
      const original = {
        address: failed.address,
        sessionFile: failed.sessionFile,
        createdAt: failed.createdAt,
        effort: failed.effort,
        lifecycle: failed.lifecycle,
      };

      mark = client.mark();
      await client.prompt("E2E PROVIDER RESTART");
      const managed = await client.waitFor(toolEnd("manage_agent"), "explicit same-identity restart", 90_000, mark);
      assert.equal(managed.isError, false);
      const recoveredWait = waitResult(await client.waitFor(toolEnd("wait_for_replies"), "reply after explicit restart", 120_000, mark));
      assert.equal(recoveredWait.items[0]?.requestId, requestId);
      assert.equal(recoveredWait.items[0]?.state, "answered");
      await client.waitForSettlement(mark);

      const recoveredRegistry = await eventuallyRegistry(
        agentDir,
        sessionId,
        (candidate) => candidate.agents?.[0]?.state === "idle",
        "with explicit same-identity recovery",
      );
      const recovered = recoveredRegistry.agents[0];
      assert.deepEqual({
        address: recovered.address,
        sessionFile: recovered.sessionFile,
        createdAt: recovered.createdAt,
        effort: recovered.effort,
        lifecycle: recovered.lifecycle,
      }, original);
      assert.equal(await readFile(effectPath, "utf8"), "terminal attempt effect occurred once\n");
      const afterMessages = activeSessionMessages(recovered.sessionFile);
      assert.equal(afterMessages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === "toolCall" && part.name === "write")
        : []).length, 1);
      const journal = await readJournal(agentDir, sessionId);
      assert.equal(journal.filter((event) => event.type === "email.created" && event.email?.id === requestId).length, 1);
      assert.equal(journal.filter((event) => event.type === "email.answered" && event.id === requestId).length, 1);
      assert.deepEqual(client.events().slice(mark).filter((line) => toolStart("manage_agent")(line) || toolStart("wait_for_replies")(line)).map((line) => line.toolName), [
        "manage_agent",
        "wait_for_replies",
      ]);
      assert.equal(await client.close(), 0, client.stderr);
    } finally {
      await client.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
      await rm(effectDir, { recursive: true, force: true });
    }
  });
});
