import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { MailStore } from "../../src/mail-store.ts";
import { PiRpcClient, type RpcLine } from "./helpers/rpc-client.ts";

const PROVIDERS = resolve("test/e2e/helpers/duplicate-model-provider-extension.ts");
const EXTENSION = resolve("src/index.ts");
const MODEL_ID = "shared";
const ALPHA = "mock-alpha";
const BETA = "mock-beta";
const ALPHA_ADDRESS = "worker.alpha@shared.com";
const BETA_ADDRESS = "worker.beta@shared.com";
const NEW_ADDRESS = "worker.after-restart@shared.com";

interface Running {
  client: PiRpcClient;
  sessionId: string;
  sessionFile: string;
}

async function launch(
  agentDir: string,
  provider: string,
  enabled = `${ALPHA},${BETA}`,
  session?: string,
): Promise<Running> {
  const client = PiRpcClient.launch({
    cwd: process.cwd(),
    agentDir,
    model: `${provider}/${MODEL_ID}`,
    extensions: [PROVIDERS, EXTENSION],
    persistSession: true,
    ...(session ? { session } : {}),
    env: { PI_ROUTING_PROVIDERS: enabled },
  });
  const state = await client.getState();
  assert.equal(state.success, true, client.stderr);
  const data = state.data as { sessionId?: string; sessionFile?: string } | undefined;
  assert.ok(data?.sessionId);
  assert.ok(data.sessionFile);
  return { client, sessionId: data.sessionId, sessionFile: data.sessionFile };
}

async function resume(agentDir: string, sessionFile: string, provider: string, enabled = `${ALPHA},${BETA}`): Promise<Running> {
  const running = await launch(agentDir, provider, enabled, sessionFile);
  const selected = await running.client.setModel(provider, MODEL_ID);
  assert.equal(selected.success, true, running.client.stderr);
  const state = await running.client.getState();
  const data = state.data as { sessionId?: string; sessionFile?: string; model?: { provider?: string; id?: string } } | undefined;
  assert.equal(data?.model?.provider, provider);
  assert.equal(data?.model?.id, MODEL_ID);
  assert.ok(data?.sessionId);
  assert.equal(data?.sessionFile, sessionFile);
  return { client: running.client, sessionId: data.sessionId, sessionFile };
}

function toolEnd(toolName: string) {
  return (line: RpcLine) => line.type === "tool_execution_end" && line.toolName === toolName;
}

function toolResult(line: RpcLine): any {
  return (line.result as { details?: { result?: unknown } } | undefined)?.details?.result;
}

function resultText(line: RpcLine): string {
  const content = (line.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return content?.find((item) => item.type === "text")?.text ?? "";
}

async function promptSend(client: PiRpcClient, instruction: string, expectedProvider?: string): Promise<any> {
  const mark = client.mark();
  await client.prompt(instruction);
  const end = await client.waitFor(toolEnd("send_email"), `${instruction} send`, 120_000, mark);
  if (!expectedProvider) return end;
  assert.equal(end.isError, false, resultText(end));
  const sent = toolResult(end);
  assert.equal(sent.recipientProvider, expectedProvider);
  assert.equal(sent.recipientModel, MODEL_ID);
  const waited = await client.waitFor(toolEnd("wait_for_replies"), `${instruction} reply`, 120_000, mark);
  assert.equal(toolResult(waited).items[0]?.state, "answered");
  await client.waitForSettlement(mark, 120_000);
  return sent;
}

async function promptManage(client: PiRpcClient, instruction: string, expectError = false): Promise<RpcLine> {
  const mark = client.mark();
  await client.prompt(instruction);
  const end = await client.waitFor(toolEnd("manage_agent"), `${instruction} manage`, 120_000, mark);
  assert.equal(end.isError, expectError, resultText(end));
  await client.waitForSettlement(mark, 120_000);
  return end;
}

async function readRegistry(agentDir: string, sessionId: string): Promise<any> {
  return JSON.parse(await readFile(join(agentDir, "subagents", sessionId, "registry.json"), "utf8"));
}

async function eventuallyRegistry(
  agentDir: string,
  sessionId: string,
  predicate: (registry: any) => boolean,
  description: string,
  timeoutMs = 60_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      last = await readRegistry(agentDir, sessionId);
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  assert.fail(`Timed out waiting for registry ${description}: ${JSON.stringify(last)?.slice(0, 800)}`);
}

async function waitMainIdle(client: PiRpcClient, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client.getState();
    if ((state.data as { isStreaming?: boolean } | undefined)?.isStreaming === false) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  assert.fail("Main session remained streaming.");
}

async function readJournal(agentDir: string, sessionId: string): Promise<any[]> {
  const raw = await readFile(join(agentDir, "subagents", sessionId, "mail.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function createdEmails(events: readonly any[]): any[] {
  const byId = new Map<string, any>();
  for (const event of events) {
    if (event.type === "email.created" && event.email?.id) byId.set(event.email.id, event.email);
  }
  return [...byId.values()];
}

function agent(registry: any, address: string): any {
  const matches = registry.agents.filter((record: any) => record.address === address);
  assert.equal(matches.length, 1, `expected one record for ${address}`);
  return matches[0];
}

function assistantProviders(sessionFile: string): string[] {
  return SessionManager.open(sessionFile).getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => (entry as any).message.provider)
    .filter(Boolean);
}

async function seedMainSession(agentDir: string, provider = ALPHA, enabled = `${ALPHA},${BETA}`): Promise<Running> {
  const running = await launch(agentDir, provider, enabled);
  const mark = running.client.mark();
  await running.client.prompt("E2E ROUTE READY");
  await running.client.waitForSettlement(mark);
  const state = await running.client.getState();
  const data = state.data as { sessionId?: string; sessionFile?: string } | undefined;
  assert.ok(data?.sessionId);
  assert.ok(data.sessionFile);
  assert.equal(await running.client.close(), 0, running.client.stderr);
  return { client: running.client, sessionId: data.sessionId, sessionFile: data.sessionFile };
}

async function writeOrphans(
  agentDir: string,
  sessionId: string,
  entries: Array<{ id: string; address: string; binding?: { provider: string; modelId: string } }>,
): Promise<void> {
  const registryPath = join(agentDir, "subagents", sessionId, "registry.json");
  const registry = await readRegistry(agentDir, sessionId);
  registry.agents = [];
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  const store = new MailStore(join(agentDir, "subagents", sessionId, "mail.jsonl"));
  await store.init();
  for (const [index, entry] of entries.entries()) {
    await store.accept({
      id: entry.id,
      from: "main@shared.com",
      to: entry.address,
      subject: entry.id,
      message: "Recover this accepted crash-window request.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date(Date.now() + index).toISOString(),
      deliveryState: "queued",
      effortIntent: "high",
      lifecycleIntent: structuredClone(DEFAULT_CONFIG.lifecycle),
      ...(entry.binding ? { modelBindingIntent: entry.binding } : {}),
    });
  }
}

describe("real Pi provider-aware durable routing", { concurrency: false }, () => {
  it("selects by current provider, preserves archive/reuse and process restore, and fails closed across removal/reintroduction", { timeout: 600_000 }, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-email-provider-routing-e2e-"));
    let current: PiRpcClient | undefined;
    try {
      const first = await launch(agentDir, ALPHA);
      current = first.client;
      const alphaSent = await promptSend(current, "E2E ROUTE SEND ALPHA", ALPHA);
      assert.deepEqual(alphaSent.envelope.modelBindingIntent, { provider: ALPHA, modelId: MODEL_ID });
      const registryAfterAlpha = await eventuallyRegistry(agentDir, first.sessionId, (value) => agent(value, ALPHA_ADDRESS).state === "idle", "alpha idle");
      const alphaSession = agent(registryAfterAlpha, ALPHA_ADDRESS).sessionFile;
      const initialAlphaProviders = assistantProviders(alphaSession);
      assert.ok(initialAlphaProviders.length > 0);
      assert.deepEqual([...new Set(initialAlphaProviders)], [ALPHA]);
      await promptManage(current, "E2E ROUTE ARCHIVE ALPHA");

      const mainBefore = (await readRegistry(agentDir, first.sessionId)).mainAddress;
      const selected = await current.setModel(BETA, MODEL_ID);
      assert.equal(selected.success, true);
      const betaSent = await promptSend(current, "E2E ROUTE SEND BETA", BETA);
      assert.deepEqual(betaSent.envelope.modelBindingIntent, { provider: BETA, modelId: MODEL_ID });
      assert.equal((await readRegistry(agentDir, first.sessionId)).mainAddress, mainBefore, "same model ID keeps textual main address");

      const restoredAlpha = await promptSend(current, "E2E ROUTE SEND ALPHA", ALPHA);
      assert.equal(restoredAlpha.recipientDisposition, "restored");
      assert.equal(restoredAlpha.envelope.modelBindingIntent, undefined);
      let registry = await eventuallyRegistry(
        agentDir,
        first.sessionId,
        (value) => agent(value, ALPHA_ADDRESS).state === "idle" && agent(value, BETA_ADDRESS).state === "idle",
        "alpha and beta idle",
      );
      assert.equal(agent(registry, ALPHA_ADDRESS).provider, ALPHA);
      assert.equal(agent(registry, BETA_ADDRESS).provider, BETA);
      assert.deepEqual([...new Set(assistantProviders(agent(registry, BETA_ADDRESS).sessionFile))], [BETA]);
      assert.equal(agent(registry, ALPHA_ADDRESS).sessionFile, alphaSession);
      assert.deepEqual([...new Set(assistantProviders(agent(registry, ALPHA_ADDRESS).sessionFile))], [ALPHA]);
      const sessionFile = first.sessionFile;
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;

      const resumed = await resume(agentDir, sessionFile, BETA);
      current = resumed.client;
      await waitMainIdle(current);
      registry = await eventuallyRegistry(
        agentDir,
        resumed.sessionId,
        (value) => agent(value, ALPHA_ADDRESS).provider === ALPHA && agent(value, BETA_ADDRESS).provider === BETA,
        "exact process restore bindings",
      );
      assert.equal(agent(registry, ALPHA_ADDRESS).sessionFile, alphaSession);
      const newSent = await promptSend(current, "E2E ROUTE SEND NEW", BETA);
      assert.deepEqual(newSent.envelope.modelBindingIntent, { provider: BETA, modelId: MODEL_ID });
      registry = await readRegistry(agentDir, resumed.sessionId);
      assert.equal(agent(registry, NEW_ADDRESS).provider, BETA);
      assert.deepEqual([...new Set(assistantProviders(agent(registry, NEW_ADDRESS).sessionFile))], [BETA]);
      assert.equal(registry.agents.filter((record: any) => record.address === ALPHA_ADDRESS).length, 1);
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;

      const missing = await resume(agentDir, sessionFile, BETA, BETA);
      current = missing.client;
      registry = await eventuallyRegistry(
        agentDir,
        missing.sessionId,
        (value) => agent(value, ALPHA_ADDRESS).state === "failed" && agent(value, BETA_ADDRESS).state !== "failed",
        "removed alpha unavailable and beta restored",
      );
      const unavailable = agent(registry, ALPHA_ADDRESS);
      assert.equal(unavailable.provider, ALPHA);
      assert.equal(unavailable.modelId, MODEL_ID);
      assert.equal(unavailable.sessionFile, alphaSession);
      assert.match(unavailable.failure, /bound to mock-alpha\/shared.*not rebound/is);
      await waitMainIdle(current);
      const journalBeforeQueue = createdEmails(await readJournal(agentDir, missing.sessionId));
      const accepted = await promptSend(current, "E2E ROUTE SEND ALPHA");
      assert.equal(accepted.isError, false, resultText(accepted));
      const acceptedResult = toolResult(accepted);
      assert.equal(acceptedResult.recipientDisposition, "failed");
      assert.equal(acceptedResult.recipientProvider, ALPHA);
      assert.equal(acceptedResult.envelope.deliveryState, "queued");
      assert.equal(acceptedResult.spawned, false);
      const createdAfterQueue = createdEmails(await readJournal(agentDir, missing.sessionId));
      assert.equal(createdAfterQueue.length, journalBeforeQueue.length + 1);
      assert.equal(createdAfterQueue.at(-1)?.id, acceptedResult.envelope.id);
      await waitMainIdle(current);
      const restart = await promptManage(current, "E2E ROUTE RESTART ALPHA", true);
      assert.match(resultText(restart), /bound to mock-alpha\/shared.*not rebound/is);
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;

      const returned = await resume(agentDir, sessionFile, BETA);
      current = returned.client;
      registry = await eventuallyRegistry(
        agentDir,
        returned.sessionId,
        (value) => agent(value, ALPHA_ADDRESS).state !== "failed" && agent(value, ALPHA_ADDRESS).provider === ALPHA,
        "reintroduced exact alpha restored",
      );
      assert.equal(agent(registry, ALPHA_ADDRESS).sessionFile, alphaSession);
      assert.deepEqual([...new Set(assistantProviders(alphaSession))], [ALPHA]);

      const journal = await readJournal(agentDir, returned.sessionId);
      const created = createdEmails(journal);
      const alphaCreations = created.filter((email) => email.to === ALPHA_ADDRESS);
      assert.deepEqual(alphaCreations[0]?.modelBindingIntent, { provider: ALPHA, modelId: MODEL_ID });
      assert.ok(alphaCreations.slice(1).every((email) => email.modelBindingIntent === undefined));
      assert.deepEqual(created.find((email) => email.to === BETA_ADDRESS)?.modelBindingIntent, { provider: BETA, modelId: MODEL_ID });
      assert.deepEqual(created.find((email) => email.to === NEW_ADDRESS)?.modelBindingIntent, { provider: BETA, modelId: MODEL_ID });
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;
    } finally {
      await current?.close().catch(() => undefined);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("recovers exact crash-window intent, leaves ambiguous legacy mail unavailable, and uniquely migrates a legacy orphan", { timeout: 360_000 }, async () => {
    const duplicateDir = await mkdtemp(join(tmpdir(), "pi-email-provider-orphan-e2e-"));
    const uniqueDir = await mkdtemp(join(tmpdir(), "pi-email-provider-legacy-e2e-"));
    let current: PiRpcClient | undefined;
    try {
      const seeded = await seedMainSession(duplicateDir, ALPHA);
      await writeOrphans(duplicateDir, seeded.sessionId, [
        { id: "mail_bound_crash_window", address: "worker.bound-crash@shared.com", binding: { provider: ALPHA, modelId: MODEL_ID } },
        { id: "mail_legacy_ambiguous", address: "worker.legacy-ambiguous@shared.com" },
      ]);
      assert.deepEqual(
        createdEmails(await readJournal(duplicateDir, seeded.sessionId)).map((email) => email.id),
        ["mail_bound_crash_window", "mail_legacy_ambiguous"],
      );
      const recovered = await resume(duplicateDir, seeded.sessionFile, BETA);
      current = recovered.client;
      assert.equal(recovered.sessionId, seeded.sessionId, "resume keeps the original namespace ID");
      assert.deepEqual(
        createdEmails(await readJournal(duplicateDir, recovered.sessionId))
          .map((email) => email.id)
          .filter((id) => id === "mail_bound_crash_window" || id === "mail_legacy_ambiguous"),
        ["mail_bound_crash_window", "mail_legacy_ambiguous"],
      );
      let registry = await eventuallyRegistry(
        duplicateDir,
        recovered.sessionId,
        (value) => value.agents?.find((record: any) => record.address === "worker.bound-crash@shared.com")?.provider === ALPHA
          && value.agents?.find((record: any) => record.address === "worker.legacy-ambiguous@shared.com")?.state === "failed",
        "bound and legacy duplicate orphan outcomes",
      );
      const bound = agent(registry, "worker.bound-crash@shared.com");
      assert.equal(bound.provider, ALPHA);
      assert.equal(bound.effort, "high");
      assert.deepEqual(bound.lifecycle, DEFAULT_CONFIG.lifecycle);
      const ambiguous = agent(registry, "worker.legacy-ambiguous@shared.com");
      assert.equal(ambiguous.provider, "unavailable");
      assert.match(ambiguous.failure, /original provider cannot be inferred.*no substitution/is);
      assert.equal(ambiguous.sessionFile, undefined);
      const duplicateMail = createdEmails(await readJournal(duplicateDir, recovered.sessionId));
      assert.deepEqual(
        duplicateMail.find((email) => email.id === "mail_bound_crash_window")?.modelBindingIntent,
        { provider: ALPHA, modelId: MODEL_ID },
      );
      assert.equal(duplicateMail.find((email) => email.id === "mail_legacy_ambiguous")?.modelBindingIntent, undefined);
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;

      const uniqueSeed = await seedMainSession(uniqueDir, ALPHA, ALPHA);
      await writeOrphans(uniqueDir, uniqueSeed.sessionId, [
        { id: "mail_legacy_unique", address: "worker.legacy-unique@shared.com" },
      ]);
      assert.deepEqual(
        createdEmails(await readJournal(uniqueDir, uniqueSeed.sessionId)).map((email) => email.id),
        ["mail_legacy_unique"],
      );
      const migrated = await resume(uniqueDir, uniqueSeed.sessionFile, ALPHA, ALPHA);
      current = migrated.client;
      assert.equal(migrated.sessionId, uniqueSeed.sessionId, "legacy resume keeps the original namespace ID");
      registry = await eventuallyRegistry(
        uniqueDir,
        migrated.sessionId,
        (value) => value.agents?.find((record: any) => record.address === "worker.legacy-unique@shared.com")?.provider === ALPHA,
        "legacy unique migration",
      );
      const legacy = agent(registry, "worker.legacy-unique@shared.com");
      assert.equal(legacy.provider, ALPHA);
      assert.ok(legacy.activity.some((item: any) => /Legacy provider binding uniquely migrated to mock-alpha\/shared/.test(item.summary)));
      assert.equal(createdEmails(await readJournal(uniqueDir, migrated.sessionId)).find((email) => email.id === "mail_legacy_unique")?.modelBindingIntent, undefined);
      assert.equal(await current.close(), 0, current.stderr);
      current = undefined;
    } finally {
      await current?.close().catch(() => undefined);
      await rm(duplicateDir, { recursive: true, force: true });
      await rm(uniqueDir, { recursive: true, force: true });
    }
  });
});
