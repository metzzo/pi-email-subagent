import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { SdkWorker } from "../../src/sdk-worker.ts";
import { WorkerSettingsSnapshot } from "../../src/settings-snapshot.ts";
import type { AgentRecord } from "../../src/types.ts";
import type { WorkerExtensionRegistration } from "../../src/worker-extensions.ts";

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

function nativeErrorStream(model: Model<Api>) {
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
    errorMessage: "Authorization: Bearer SENTINEL_PROTECTED_NATIVE_ERROR",
    timestamp: Date.now(),
  } as AssistantMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
}

function singleToolStream(model: Model<Api>, name: string) {
  const stream = createAssistantMessageEventStream();
  const toolCall = { type: "toolCall" as const, id: `${name}-call`, name, arguments: {} };
  const message = {
    role: "assistant",
    content: [toolCall],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AssistantMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
}

function contextOverflowStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "context length exceeded",
    timestamp: Date.now(),
  } as AssistantMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
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

it("constructs and disposes an isolated real AgentSession with only explicit worker extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-"));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model, "expected at least one built-in model");
  const record = workerRecord(model);
  record.tools.splice(4, 0, "not_a_real_tool");
  const settingsSnapshot = WorkerSettingsSnapshot.capture(root, root, false);
  let sessionStarts = 0;
  let sessionShutdowns = 0;
  const workerExtension: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "compact-warning-probe",
    tools: ["compact_and_continue"],
    factory(pi) {
      pi.on("session_start", () => { sessionStarts += 1; });
      pi.on("session_shutdown", () => { sessionShutdowns += 1; });
      pi.registerTool({
        name: "compact_and_continue",
        label: "compact_and_continue",
        description: "Worker extension probe.",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "probe" }], details: {} };
        },
      });
    },
  };
  const worker = new SdkWorker(runtime, undefined, settingsSnapshot, [workerExtension]);
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
  assert.equal(snapshot.record.tools.includes("compact_and_continue"), true);
  assert.equal(snapshot.record.tools.includes("not_a_real_tool"), false);
  assert.equal(snapshot.record.tools.includes("inspect_agent"), false);
  assert.equal(snapshot.record.tools.includes("wait_for_replies"), false);
  assert.equal(snapshot.record.tools.includes("manage_agent"), false);
  assert.equal(snapshot.record.activity.some((item) => item.summary.includes("Unknown tools omitted")), true);
  assert.ok(worker.getSessionFile());
  assert.equal(sessionStarts, 1, "bound worker extension should receive one session_start");
  await worker.dispose();
  assert.equal(sessionShutdowns, 1, "normal worker disposal should emit exactly one session_shutdown");
  await worker.dispose();
  assert.equal(sessionShutdowns, 1, "repeated disposal must not duplicate session_shutdown");
  assert.equal(worker.getSessionFile(), snapshot.record.sessionFile);
});

it("loads an opted-in worker extension and delivers its steering message inside a subagent run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-steering-"));
  const observed: SimpleStreamOptions[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  runtime.registerProvider("worker-extension-steering", {
    name: "Worker Extension Steering",
    baseUrl: "http://127.0.0.1:9/worker-extension-steering",
    apiKey: "deterministic-test-key",
    api: "worker-extension-steering",
    models: [{
      id: "steering-model", name: "Steering Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple: successfulStream(observed),
  });
  const model = runtime.getModel("worker-extension-steering", "steering-model");
  assert.ok(model);
  const registration: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "steering-probe",
    tools: [],
    factory(pi) {
      let delivered = false;
      pi.on("turn_end", () => {
        if (delivered) return;
        delivered = true;
        pi.sendMessage(
          { customType: "worker-extension-probe", content: "SUBAGENT_STEERING_SENTINEL", display: true },
          { deliverAs: "steer", triggerTurn: true },
        );
      });
    },
  };
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false), [registration]);
  let modelStarts = 0;
  let workerSettlements = 0;
  worker.subscribe((event) => {
    if (event.type === "run_liveness" && event.phase === "model_start") modelStarts += 1;
    if (event.type === "settled") workerSettlements += 1;
  });
  try {
    await worker.start({
      record: workerRecord(model, "scout.steering@steering-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise worker extension steering.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "settled") { unsubscribe(); resolve(); }
      });
    });
    await worker.prompt("run the steering probe");
    await settled;
    assert.equal(observed.length, 2, "the steering message should trigger exactly one additional model turn");
    assert.equal(modelStarts, 1, "steering drained by the active agent loop should not invent a second low-level start");
    assert.equal(workerSettlements, 1, "the full steered prompt operation should emit one worker settlement");
    const sessionFile = worker.getSessionFile();
    assert.ok(sessionFile);
    const customMessages = SessionManager.open(sessionFile).getBranch()
      .filter((entry) => entry.type === "custom_message")
      .map((entry) => (entry as any).content);
    assert.deepEqual(customMessages, ["SUBAGENT_STEERING_SENTINEL"]);
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("emits one worker settlement after a real overflow compaction retry with multiple agent starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-overflow-retry-"));
  await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2_000, keepRecentTokens: 1_000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const observed: SimpleStreamOptions[] = [];
  let providerCalls = 0;
  runtime.registerProvider("worker-overflow-retry", {
    name: "Worker Overflow Retry",
    baseUrl: "http://127.0.0.1:9/worker-overflow-retry",
    apiKey: "deterministic-test-key",
    api: "worker-overflow-retry",
    models: [{
      id: "overflow-model", name: "Overflow Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple(model, context, options) {
      providerCalls += 1;
      if (providerCalls === 3) return contextOverflowStream(model);
      return successfulStream(observed)(model, context, options);
    },
  });
  const model = runtime.getModel("worker-overflow-retry", "overflow-model");
  assert.ok(model);
  const registration: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "overflow-summary-probe",
    tools: [],
    factory(pi) {
      pi.on("session_before_compact", (event) => ({
        compaction: {
          summary: "deterministic overflow recovery summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      }));
    },
  };
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false), [registration]);
  let modelStarts = 0;
  let settlements = 0;
  worker.subscribe((event) => {
    if (event.type === "run_liveness" && event.phase === "model_start") modelStarts += 1;
    if (event.type === "settled") settlements += 1;
  });
  try {
    await worker.start({
      record: workerRecord(model, "scout.overflow-retry@overflow-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise overflow compaction retry.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const seed = async (message: string): Promise<void> => {
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = worker.subscribe((event) => {
          if (event.type === "settled") { unsubscribe(); resolve(); }
        });
      });
      await worker.prompt(message);
      await settled;
    };
    await seed("seed prior history");
    await seed(`seed large retained turn\n${"state ".repeat(4_000)}`);
    modelStarts = 0;
    settlements = 0;
    const recovered = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "settled") { unsubscribe(); resolve(); }
      });
    });
    await worker.prompt("trigger deterministic overflow recovery");
    await recovered;
    assert.equal(providerCalls, 4, "overflow recovery should retry the provider exactly once after compaction");
    assert.equal(modelStarts, 2, "overflow recovery should expose two low-level agent starts inside one prompt operation");
    assert.equal(settlements, 1, "the full overflow recovery operation should emit one worker settlement");
    assert.equal(worker.getSnapshot().record.state, "idle", "worker must not remain stuck running after the single outer settlement");
    const sessionFile = worker.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(SessionManager.open(sessionFile).getBranch().some((entry) => entry.type === "compaction"), true, "the real session should persist overflow compaction");
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("binds worker extension lifecycle and collapses nested AgentSession settlements into one worker settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-nested-settlement-"));
  const observed: SimpleStreamOptions[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  runtime.registerProvider("worker-nested-settlement", {
    name: "Worker Nested Settlement",
    baseUrl: "http://127.0.0.1:9/worker-nested-settlement",
    apiKey: "deterministic-test-key",
    api: "worker-nested-settlement",
    models: [{
      id: "nested-model", name: "Nested Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple: successfulStream(observed),
  });
  const model = runtime.getModel("worker-nested-settlement", "nested-model");
  assert.ok(model);
  let sessionStarts = 0;
  const registration: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "nested-settlement-probe",
    tools: [],
    factory(pi) {
      let triggered = false;
      let releaseOuter: (() => void) | undefined;
      pi.on("session_start", () => { sessionStarts += 1; });
      pi.on("agent_settled", async () => {
        if (releaseOuter) {
          const release = releaseOuter;
          releaseOuter = undefined;
          release();
          return;
        }
        if (triggered) return;
        triggered = true;
        await new Promise<void>((resolve) => {
          releaseOuter = resolve;
          pi.sendMessage(
            { customType: "nested-settlement-probe", content: "continue once", display: true },
            { deliverAs: "steer", triggerTurn: true },
          );
        });
      });
    },
  };
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false), [registration]);
  let settlements = 0;
  worker.subscribe((event) => { if (event.type === "settled") settlements += 1; });
  try {
    await worker.start({
      record: workerRecord(model, "scout.nested-settlement@nested-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise nested settlement.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    assert.equal(sessionStarts, 1, "explicit lifecycle binding should emit one session_start");
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "settled") { unsubscribe(); resolve(); }
      });
    });
    await worker.prompt("run nested settlement probe");
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(observed.length, 2, "the nested continuation should run exactly once");
    assert.equal(settlements, 1, "nested and outer AgentSession settlements should collapse into one worker settlement");
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("aborts compaction and joins the full admitted prompt before certifying worker cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-compaction-cleanup-"));
  await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2_000, keepRecentTokens: 1_000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  let allowCompaction = false;
  let sessionShutdowns = 0;
  let compactionSignal: AbortSignal | undefined;
  let finishCompaction: (() => void) | undefined;
  let compactionStarted!: () => void;
  const compactionStart = new Promise<void>((resolve) => { compactionStarted = resolve; });
  runtime.registerProvider("worker-compaction-cleanup", {
    name: "Worker Compaction Cleanup",
    baseUrl: "http://127.0.0.1:9/worker-compaction-cleanup",
    apiKey: "deterministic-test-key",
    api: "worker-compaction-cleanup",
    models: [{
      id: "compaction-model", name: "Compaction Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple: successfulStream([]),
  });
  const model = runtime.getModel("worker-compaction-cleanup", "compaction-model");
  assert.ok(model);
  const registration: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "compaction-cleanup-probe",
    tools: [],
    factory(pi) {
      let started = false;
      pi.on("session_shutdown", () => { sessionShutdowns += 1; });
      pi.on("session_before_compact", async (event) => {
        compactionSignal = event.signal;
        compactionStarted();
        await new Promise<void>((resolve) => { finishCompaction = resolve; });
        return { cancel: true };
      });
      pi.on("agent_settled", async (_event, ctx) => {
        if (!allowCompaction || started) return;
        started = true;
        await new Promise<void>((resolve) => {
          ctx.compact({ customInstructions: "cleanup probe", onComplete: () => resolve(), onError: () => resolve() });
        });
      });
    },
  };
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false), [registration]);
  try {
    await worker.start({
      record: workerRecord(model, "scout.compaction-cleanup@compaction-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise compaction cleanup.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const seeded = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "settled") { unsubscribe(); resolve(); }
      });
    });
    await worker.prompt("seed a prior turn for compaction");
    await seeded;
    allowCompaction = true;
    await worker.prompt(`start compaction cleanup probe\n${"state ".repeat(4_000)}`);
    await compactionStart;
    const internal = worker as unknown as { session: { isCompacting: boolean }; promptOperations: Set<Promise<void>> };
    assert.equal(internal.session.isCompacting, true);
    assert.equal(internal.promptOperations.size, 1);
    const cleanup = worker.cleanup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sessionShutdowns, 1, "cleanup should emit session_shutdown before disposing the worker session");
    assert.equal(compactionSignal?.aborted, true, "cleanup should abort the active compaction signal");
    assert.ok(finishCompaction);
    finishCompaction();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupTimeout = new Promise<never>((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error("cleanup did not join the admitted prompt")), 1_000);
    });
    const report = await Promise.race([cleanup, cleanupTimeout]).finally(() => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    });
    assert.equal(report.abort, "succeeded");
    assert.equal(report.sessionIdle, true);
    assert.equal(report.sessionDisposed, true);
    assert.equal(report.quiescence, "verified");
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("emits shutdown before abort settlement can start newly accepted extension work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-shutdown-race-"));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  let providerCalls = 0;
  runtime.registerProvider("worker-shutdown-race", {
    name: "Worker Shutdown Race",
    baseUrl: "http://127.0.0.1:9/worker-shutdown-race",
    apiKey: "deterministic-test-key",
    api: "worker-shutdown-race",
    models: [{
      id: "shutdown-model", name: "Shutdown Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple(model) {
      providerCalls += 1;
      return singleToolStream(model, "arm_compaction");
    },
  });
  const model = runtime.getModel("worker-shutdown-race", "shutdown-model");
  assert.ok(model);
  let armed = false;
  let shutdowns = 0;
  let postAcceptSettlements = 0;
  const registration: WorkerExtensionRegistration = {
    protocolVersion: 1,
    name: "shutdown-race-probe",
    tools: ["arm_compaction"],
    factory(pi) {
      pi.registerTool({
        name: "arm_compaction",
        label: "arm_compaction",
        description: "Arm settlement work for the cleanup race test.",
        parameters: Type.Object({}),
        async execute() {
          armed = true;
          return { content: [{ type: "text", text: "armed" }], details: {}, terminate: true };
        },
      });
      pi.on("session_shutdown", () => {
        shutdowns += 1;
        armed = false;
      });
      pi.on("agent_settled", (_event, ctx) => {
        if (!armed) return;
        postAcceptSettlements += 1;
        ctx.compact({ customInstructions: "must not start after shutdown" });
      });
    },
  };
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false), [registration]);
  let cleanup: ReturnType<SdkWorker["cleanup"]> | undefined;
  worker.subscribe((event) => {
    if (event.type === "tool_lifecycle" && event.phase === "end" && event.toolName === "arm_compaction") {
      cleanup = worker.cleanup();
    }
  });
  try {
    await worker.start({
      record: workerRecord(model, "scout.shutdown-race@shutdown-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Exercise shutdown before settlement work.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    await worker.prompt("arm cleanup race");
    for (let attempt = 0; cleanup === undefined && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(cleanup, "tool completion should start cleanup at the pre-settlement boundary");
    const report = await cleanup;
    assert.equal(providerCalls, 1, "shutdown must prevent any nested compaction provider call");
    assert.equal(shutdowns, 1, "cleanup should emit exactly one shutdown");
    assert.equal(postAcceptSettlements, 0, "shutdown should disarm settlement work before abort can settle the prompt");
    assert.equal(report.quiescence, "verified");
  } finally {
    await worker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps native provider detail in the protected session while shared worker surfaces use one safe summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-safe-error-"));
  const previousFixtureAuth = process.env.PI_EMAIL_SAFE_ERROR_FIXTURE_AUTH;
  process.env.PI_EMAIL_SAFE_ERROR_FIXTURE_AUTH = "configured";
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  runtime.registerProvider("worker-safe-error", {
    name: "Worker Safe Error",
    baseUrl: "http://127.0.0.1:9/worker-safe-error",
    apiKey: "$PI_EMAIL_SAFE_ERROR_FIXTURE_AUTH",
    api: "worker-safe-error",
    models: [{
      id: "safe-error-model", name: "Safe Error Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    }],
    streamSimple: nativeErrorStream,
  });
  const model = runtime.getModel("worker-safe-error", "safe-error-model");
  assert.ok(model);
  const worker = new SdkWorker(runtime, model, WorkerSettingsSnapshot.capture(root, root, false));
  const events: unknown[] = [];
  worker.subscribe((event) => events.push(event));
  try {
    await worker.start({
      record: workerRecord(model, "scout.safe-error@safe-error-model.com"),
      model,
      cwd: root,
      agentDir: root,
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      systemPrompt: "Keep native detail protected.",
      sendEmail: async () => { throw new Error("not called"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = worker.subscribe((event) => {
        if (event.type === "settled") { unsubscribe(); resolve(); }
      });
    });
    await worker.prompt("fail once without retry");
    await settled;
    const shared = JSON.stringify({ snapshot: worker.getSnapshot(), events });
    assert.doesNotMatch(shared, /SENTINEL_PROTECTED_NATIVE_ERROR/);
    assert.match(shared, /Authorization: \[redacted\]/);
    const sessionFile = worker.getSessionFile();
    assert.ok(sessionFile);
    const native = SessionManager.open(sessionFile).getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .map((entry) => (entry as any).message.errorMessage)
      .filter(Boolean);
    assert.ok(native.some((message) => /SENTINEL_PROTECTED_NATIVE_ERROR/.test(message)));
  } finally {
    await worker.dispose().catch(() => undefined);
    if (previousFixtureAuth === undefined) delete process.env.PI_EMAIL_SAFE_ERROR_FIXTURE_AUTH;
    else process.env.PI_EMAIL_SAFE_ERROR_FIXTURE_AUTH = previousFixtureAuth;
    await rm(root, { recursive: true, force: true });
  }
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
        if (event.type === "activity" && event.activity?.summary.startsWith("Pi agent retry")) {
          unsubscribe(); resolve();
        }
      });
    });
    await worker.prompt("enter retry backoff");
    await retryStarted;
    const beforeCleanup = worker.getSnapshot().record;
    const report = await worker.cleanup();
    assert.equal(report.sessionDisposed, true);
    assert.equal(report.sessionIdle, true);
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
    httpProxy: "http://127.0.0.1:8765",
    shellPath: "/bin/sh",
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
    assert.deepEqual(lowSession.settingsManager.getProviderRetrySettings(), { timeoutMs: 5_001, maxRetries: 2, maxRetryDelayMs: 2_001 });
    assert.equal(lowSession.settingsManager.getTransport(), "websocket");
    assert.equal(lowSession.settingsManager.getHttpIdleTimeoutMs(), 3_001);
    assert.equal(lowSession.settingsManager.getWebSocketConnectTimeoutMs(), 4_001);
    assert.equal(lowSession.settingsManager.getGlobalSettings().httpProxy, "http://127.0.0.1:8765");
    assert.equal(lowSession.settingsManager.getShellPath(), "/bin/sh");
    assert.deepEqual(lowSession.settingsManager.getCompactionSettings(), { enabled: false, reserveTokens: 15_001, keepRecentTokens: 13_001 });
    assert.deepEqual(lowSession.settingsManager.getBranchSummarySettings(), { reserveTokens: 14_001, skipPrompt: true });
    assert.equal(lowSession.settingsManager.getShellCommandPrefix(), "project-prefix");
    assert.deepEqual(lowSession.settingsManager.getPackages(), [], "worker reload cannot install configured packages");
    assert.deepEqual(lowSession.settingsManager.getSkillPaths(), [], "worker resource loading is side-effect-free");
    assert.deepEqual(lowSession.settingsManager.getPromptTemplatePaths(), [], "worker resource loading is side-effect-free");
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
