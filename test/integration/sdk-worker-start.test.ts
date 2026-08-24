import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { SdkWorker } from "../../src/sdk-worker.ts";
import { WorkerSettingsSnapshot } from "../../src/settings-snapshot.ts";
import type { AgentRecord } from "../../src/types.ts";

function successfulStream(
  observed: SimpleStreamOptions[],
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model, _context, options) => {
    if (options) observed.push(options);
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "settings observed" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "settings observed", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "settings observed", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  };
}

function retryableErrorStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "WebSocket error: deterministic cleanup backoff",
    timestamp: Date.now(),
  } as AssistantMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
}

function workerRecord(model: Model<any>, address = `scout.sdk-start@${model.id}.com`): AgentRecord {
  const now = new Date().toISOString();
  return {
    address,
    name: "scout",
    taskSlug: "sdk-start",
    provider: model.provider,
    modelId: model.id,
    effort: "low",
    tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
    canSpawn: true,
    state: "paused",
    createdAt: now,
    updatedAt: now,
    enforcementAttempts: 0,
    lifecycle: { ...DEFAULT_LIFECYCLE },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    activity: [],
  };
}

it("constructs and disposes an isolated real AgentSession without recursively loading extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-"));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model, "expected at least one built-in model");
  const record = workerRecord(model);
  record.tools.splice(4, 0, "not_a_real_tool");
  const settingsSnapshot = WorkerSettingsSnapshot.capture(root, root, false);
  const worker = new SdkWorker(runtime, undefined, settingsSnapshot);
  await worker.start({
    record,
    model,
    cwd: root,
    agentDir: root,
    sessionDir: join(root, "sessions"),
    projectTrusted: false,
    systemPrompt: "MAILBOX_SENTINEL: send_email and fetch_emails are required.",
    sendEmail: async () => { throw new Error("not called"); },
    fetchEmails: () => ({ emails: [], total: 0 }),
  });
  const snapshot = worker.getSnapshot();
  assert.equal(snapshot.record.state, "idle");
  assert.equal(snapshot.record.modelId, model.id);
  assert.equal(snapshot.record.tools.includes("send_email"), true);
  assert.equal(snapshot.record.tools.includes("fetch_emails"), true);
  assert.equal(snapshot.record.tools.includes("not_a_real_tool"), false);
  assert.equal(snapshot.record.tools.includes("inspect_agent"), false);
  assert.equal(snapshot.record.tools.includes("wait_for_replies"), false);
  assert.equal(snapshot.record.tools.includes("manage_agent"), false);
  assert.equal(snapshot.record.activity.some((item) => item.summary.includes("Unknown tools omitted")), true);
  assert.ok(worker.getSessionFile());
  await worker.dispose();
  assert.equal(worker.getSessionFile(), snapshot.record.sessionFile);
});

it("reports settings load scope without leaking invalid file content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-invalid-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "PRIVATE GLOBAL INVALID SETTINGS");
  await writeFile(join(cwd, ".pi", "settings.json"), "PRIVATE PROJECT INVALID SETTINGS");
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model);
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const beforeGlobal = await readFile(globalPath);
  const beforeProject = await readFile(projectPath);
  const settingsSnapshot = WorkerSettingsSnapshot.capture(cwd, agentDir, true);
  assert.deepEqual(settingsSnapshot.loadIssues, [{ scope: "global" }, { scope: "project" }]);
  const worker = new SdkWorker(runtime, undefined, settingsSnapshot);
  try {
    await worker.start({
      record: workerRecord(model, `scout.invalid-settings@${model.id}.com`),
      model,
      cwd,
      agentDir,
      sessionDir: join(root, "sessions"),
      projectTrusted: true,
      systemPrompt: "Invalid settings must not leak.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    worker.setEffort("high");
    const internal = worker as unknown as { session: { settingsManager: { flush(): Promise<void> } } };
    await internal.session.settingsManager.flush();
    const activity = worker.getSnapshot().record.activity.map((item) => item.summary);
    assert.doesNotMatch(JSON.stringify(activity), /PRIVATE|INVALID SETTINGS/);
    assert.deepEqual(await readFile(globalPath), beforeGlobal);
    assert.deepEqual(await readFile(projectPath), beforeProject);
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds cleanup during real Pi retry backoff and suppresses every stale session update", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-retry-cleanup-"));
  await writeFile(join(root, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  runtime.registerProvider("worker-retry-cleanup", {
    name: "Worker Retry Cleanup",
    baseUrl: "http://127.0.0.1:9/worker-retry-cleanup",
    apiKey: "deterministic-test-key",
    api: "worker-retry-cleanup",
    models: [{
      id: "retry-cleanup-model", name: "Retry Cleanup Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple: retryableErrorStream,
  });
  const model = runtime.getModel("worker-retry-cleanup", "retry-cleanup-model");
  assert.ok(model);
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false));
  try {
    await worker.start({
      record: workerRecord(model, "scout.retry-cleanup@retry-cleanup-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise deterministic retry cleanup.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const retryStarted = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "activity" && event.activity?.summary.startsWith("Provider retry")) {
          unsubscribe(); resolve();
        }
      });
    });
    await worker.prompt("enter retry backoff");
    await retryStarted;
    const beforeCleanup = worker.getSnapshot().record;
    const report = await worker.cleanup({ abortTimeoutMs: 1_000 });
    assert.equal(report.sessionDisposed, true);
    assert.equal(report.providerQuiescent, true);
    assert.equal(report.quiescence, "verified");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(worker.getSnapshot().record, beforeCleanup, "aborted retry settlement cannot update the disposed worker");
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("never writes shared settings while two workers start and change effort independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-no-settings-writes-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({
    defaultThinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 7, provider: { timeoutMs: 1_001, maxRetries: 2, maxRetryDelayMs: 2_001 } },
    transport: "sse",
    httpIdleTimeoutMs: 3_001,
    websocketConnectTimeoutMs: 4_001,
    compaction: { enabled: false, reserveTokens: 12_001, keepRecentTokens: 13_001 },
    branchSummary: { reserveTokens: 14_001, skipPrompt: true },
    shellCommandPrefix: "set -eu",
    packages: ["global-package"],
    skills: ["global-skills"],
    prompts: ["global-prompts"],
    thinkingBudgets: { low: 1_111, high: 2_222 },
  }));
  await writeFile(projectPath, JSON.stringify({
    retry: { maxRetries: 4, provider: { timeoutMs: 5_001 } },
    transport: "websocket",
    compaction: { reserveTokens: 15_001 },
    shellCommandPrefix: "project-prefix",
    prompts: ["project-prompts"],
  }));
  const globalBefore = await readFile(globalPath);
  const projectBefore = await readFile(projectPath);
  const snapshot = WorkerSettingsSnapshot.capture(cwd, agentDir, true);
  assert.deepEqual(snapshot.loadIssues, []);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model);
  const low = new SdkWorker(runtime, model, snapshot);
  const high = new SdkWorker(runtime, model, snapshot);
  const start = async (worker: SdkWorker, effort: AgentRecord["effort"], suffix: string) => {
    const record = workerRecord(model, `scout.settings-${suffix}@${model.id}.com`);
    record.effort = effort;
    await worker.start({
      record,
      model,
      cwd,
      agentDir,
      sessionDir: join(root, `sessions-${suffix}`),
      projectTrusted: true,
      systemPrompt: "Settings writes are worker-local.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
  };
  try {
    await Promise.all([start(low, "low", "low"), start(high, "high", "high")]);
    const lowSession = (low as unknown as { session: { settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager } }).session;
    const highSession = (high as unknown as { session: { settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager } }).session;
    assert.notEqual(lowSession.settingsManager, highSession.settingsManager);
    assert.equal(lowSession.settingsManager.getSteeringMode(), "all");
    assert.equal(lowSession.settingsManager.getFollowUpMode(), "all");
    assert.equal(lowSession.settingsManager.getDefaultThinkingLevel(), "low");
    assert.equal(highSession.settingsManager.getDefaultThinkingLevel(), "high");
    assert.deepEqual(lowSession.settingsManager.getRetrySettings(), { enabled: true, maxRetries: 4, baseDelayMs: 7 });
    assert.deepEqual(lowSession.settingsManager.getProviderRetrySettings(), { timeoutMs: 5_001, maxRetries: undefined, maxRetryDelayMs: 60_000 });
    assert.equal(lowSession.settingsManager.getTransport(), "websocket");
    assert.equal(lowSession.settingsManager.getHttpIdleTimeoutMs(), 3_001);
    assert.equal(lowSession.settingsManager.getWebSocketConnectTimeoutMs(), 4_001);
    assert.deepEqual(lowSession.settingsManager.getCompactionSettings(), { enabled: false, reserveTokens: 15_001, keepRecentTokens: 13_001 });
    assert.deepEqual(lowSession.settingsManager.getBranchSummarySettings(), { reserveTokens: 14_001, skipPrompt: true });
    assert.equal(lowSession.settingsManager.getShellCommandPrefix(), "project-prefix");
    assert.deepEqual(lowSession.settingsManager.getPackages(), ["global-package"]);
    assert.deepEqual(lowSession.settingsManager.getSkillPaths(), ["global-skills"]);
    assert.deepEqual(lowSession.settingsManager.getPromptTemplatePaths(), ["project-prompts"]);
    assert.deepEqual(lowSession.settingsManager.getThinkingBudgets(), { low: 1_111, high: 2_222 });

    low.setEffort("xhigh");
    high.setEffort("off");
    await Promise.all([lowSession.settingsManager.flush(), highSession.settingsManager.flush()]);
    assert.equal(low.getSnapshot().record.effort, "xhigh");
    assert.equal(high.getSnapshot().record.effort, "off");
    assert.deepEqual(await readFile(globalPath), globalBefore);
    assert.deepEqual(await readFile(projectPath), projectBefore);
  } finally {
    await Promise.all([low.dispose().catch(() => undefined), high.dispose().catch(() => undefined)]);
    await rm(root, { recursive: true, force: true });
  }
});

it("recreates worker-local effective settings when a persistent session resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-settings-resume-"));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    defaultThinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 9 },
  }));
  const before = await readFile(settingsPath);
  const snapshot = WorkerSettingsSnapshot.capture(root, root, false);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model);
  const first = new SdkWorker(runtime, model, snapshot);
  let resumed: SdkWorker | undefined;
  try {
    const startConfig = {
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Resume with the same isolated settings.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    };
    const record = workerRecord(model, `scout.settings-resume@${model.id}.com`);
    record.effort = "high";
    await first.start({ record, ...startConfig });
    const persistedRecord = first.getSnapshot().record;
    assert.ok(persistedRecord.sessionFile);
    await first.dispose();

    resumed = new SdkWorker(runtime, model, snapshot);
    await resumed.start({ record: persistedRecord, ...startConfig });
    const manager = (resumed as unknown as { session: { settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager } }).session.settingsManager;
    assert.equal(manager.getSteeringMode(), "all");
    assert.equal(manager.getDefaultThinkingLevel(), "high");
    assert.deepEqual(manager.getRetrySettings(), { enabled: true, maxRetries: 2, baseDelayMs: 9 });
    await manager.flush();
    assert.deepEqual(await readFile(settingsPath), before);
  } finally {
    await first.dispose().catch(() => undefined);
    await resumed?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("loads effective global and only trusted project retry/transport settings into a real isolated worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 3, provider: { timeoutMs: 1_111, maxRetries: 2, maxRetryDelayMs: 2_222 } },
    transport: "sse",
    httpIdleTimeoutMs: 3_333,
    websocketConnectTimeoutMs: 4_444,
  }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    retry: { maxRetries: 4, baseDelayMs: 5, provider: { timeoutMs: 5_555, maxRetries: 6, maxRetryDelayMs: 6_666 } },
    transport: "websocket",
    httpIdleTimeoutMs: 7_777,
    websocketConnectTimeoutMs: 8_888,
  }));

  try {
    for (const trusted of [true, false]) {
      const observed: SimpleStreamOptions[] = [];
      const runtime = await ModelRuntime.create({ authPath: join(root, `auth-${trusted}.json`), modelsPath: null });
      const provider = `worker-settings-${trusted}`;
      runtime.registerProvider(provider, {
        name: "Worker Settings Characterization",
        baseUrl: "http://127.0.0.1:9/worker-settings",
        apiKey: "deterministic-test-key",
        api: provider,
        models: [{
          id: "settings-model",
          name: "Settings Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 2_000,
        }],
        streamSimple: successfulStream(observed),
      });
      const model = runtime.getModel(provider, "settings-model");
      assert.ok(model);
      const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(cwd, agentDir, trusted));
      await worker.start({
        record: workerRecord(model, `scout.settings-${trusted}@settings-model.com`),
        model,
        cwd,
        agentDir,
        sessionDir: join(root, `sessions-${trusted}`),
        projectTrusted: trusted,
        systemPrompt: "Observe deterministic settings.",
        sendEmail: async () => { throw new Error("not called"); },
        fetchEmails: () => ({ emails: [], total: 0 }),
      });
      try {
        const internal = worker as unknown as { session: { settingsManager: {
          getRetrySettings(): unknown;
          getProviderRetrySettings(): unknown;
          getTransport(): unknown;
          getHttpIdleTimeoutMs(): unknown;
          getWebSocketConnectTimeoutMs(): unknown;
        } } };
        assert.deepEqual(internal.session.settingsManager.getRetrySettings(), trusted
          ? { enabled: true, maxRetries: 4, baseDelayMs: 5 }
          : { enabled: true, maxRetries: 1, baseDelayMs: 3 });
        const settled = new Promise<void>((resolve) => {
          const unsubscribe = worker.subscribe((event) => {
            if (event.type === "settled") { unsubscribe(); resolve(); }
          });
        });
        await worker.prompt("observe effective settings");
        await settled;
        assert.deepEqual({
          transport: observed[0]?.transport,
          timeoutMs: observed[0]?.timeoutMs,
          websocketConnectTimeoutMs: observed[0]?.websocketConnectTimeoutMs,
          maxRetries: observed[0]?.maxRetries,
          maxRetryDelayMs: observed[0]?.maxRetryDelayMs,
        }, trusted
          ? { transport: "websocket", timeoutMs: 5_555, websocketConnectTimeoutMs: 8_888, maxRetries: 6, maxRetryDelayMs: 6_666 }
          : { transport: "sse", timeoutMs: 1_111, websocketConnectTimeoutMs: 4_444, maxRetries: 2, maxRetryDelayMs: 2_222 });
      } finally {
        await worker.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
