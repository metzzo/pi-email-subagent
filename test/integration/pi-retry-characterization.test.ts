import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = "retry-characterization";
const MODEL = "deterministic-retry";

type ProviderStep =
  | { kind: "error"; message: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; arguments: Record<string, unknown> };

type RelevantEvent =
  | { type: "agent_start" | "agent_settled" }
  | { type: "message_end"; stopReason: string }
  | { type: "agent_end"; stopReason?: string; willRetry: boolean }
  | { type: "tool_execution_end"; toolCallId: string; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

function emptyUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function projectEvent(event: AgentSessionEvent): RelevantEvent | undefined {
  if (event.type === "agent_start" || event.type === "agent_settled") return { type: event.type };
  if (event.type === "message_end" && event.message.role === "assistant") {
    return { type: "message_end", stopReason: event.message.stopReason };
  }
  if (event.type === "agent_end") {
    const assistant = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    return { type: "agent_end", ...(assistant ? { stopReason: assistant.stopReason } : {}), willRetry: event.willRetry };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool_execution_end", toolCallId: event.toolCallId, isError: event.isError };
  }
  if (event.type === "auto_retry_start") {
    return {
      type: event.type,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      errorMessage: event.errorMessage,
    };
  }
  if (event.type === "auto_retry_end") {
    return {
      type: event.type,
      success: event.success,
      attempt: event.attempt,
      ...(event.finalError ? { finalError: event.finalError } : {}),
    };
  }
  return undefined;
}

interface CharacterizedSession {
  root: string;
  session: AgentSession;
  events: RelevantEvent[];
  calls: Array<{ transport?: string; timeoutMs?: number; websocketConnectTimeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number }>;
  dispose(): Promise<void>;
}

async function characterizedSession(
  steps: ProviderStep[],
  options: {
    retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
    settingsManager?: SettingsManager;
    tools?: ReturnType<typeof defineTool>[];
  } = {},
): Promise<CharacterizedSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-retry-characterization-"));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const calls: CharacterizedSession["calls"] = [];
  let index = 0;
  const stream = (model: Model<Api>, _context: Context, streamOptions?: SimpleStreamOptions) => {
    calls.push({
      ...(streamOptions?.transport ? { transport: streamOptions.transport } : {}),
      ...(streamOptions?.timeoutMs !== undefined ? { timeoutMs: streamOptions.timeoutMs } : {}),
      ...(streamOptions?.websocketConnectTimeoutMs !== undefined ? { websocketConnectTimeoutMs: streamOptions.websocketConnectTimeoutMs } : {}),
      ...(streamOptions?.maxRetries !== undefined ? { maxRetries: streamOptions.maxRetries } : {}),
      ...(streamOptions?.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: streamOptions.maxRetryDelayMs } : {}),
    });
    const result = createAssistantMessageEventStream();
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
    const step = steps[index++] ?? { kind: "text", text: "default success" };
    result.push({ type: "start", partial: output });
    if (step.kind === "error") {
      output.stopReason = "error";
      output.errorMessage = step.message;
      result.push({ type: "error", reason: "error", error: output });
    } else if (step.kind === "tool") {
      const call = { type: "toolCall" as const, id: step.id, name: step.name, arguments: step.arguments };
      output.content.push(call);
      result.push({ type: "toolcall_start", contentIndex: 0, partial: output });
      result.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.arguments), partial: output });
      result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
      output.stopReason = "toolUse";
      result.push({ type: "done", reason: "toolUse", message: output });
    } else {
      output.content.push({ type: "text", text: step.text });
      result.push({ type: "text_start", contentIndex: 0, partial: output });
      result.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: output });
      result.push({ type: "text_end", contentIndex: 0, content: step.text, partial: output });
      result.push({ type: "done", reason: "stop", message: output });
    }
    result.end();
    return result;
  };
  runtime.registerProvider(PROVIDER, {
    name: "Retry Characterization",
    baseUrl: "http://127.0.0.1:9/retry-characterization",
    apiKey: "deterministic-test-key",
    api: PROVIDER,
    models: [{
      id: MODEL,
      name: "Deterministic Retry",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 2_000,
    }],
    streamSimple: stream,
  });
  const model = runtime.getModel(PROVIDER, MODEL);
  assert.ok(model);
  const settingsManager = options.settingsManager ?? SettingsManager.inMemory({
    retry: options.retry ?? { enabled: true, maxRetries: 3, baseDelayMs: 1 },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model,
    tools: (options.tools ?? []).map((tool) => tool.name),
    customTools: options.tools,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  });
  const events: RelevantEvent[] = [];
  session.subscribe((event) => {
    const projected = projectEvent(event);
    if (projected) events.push(projected);
  });
  return {
    root,
    session,
    events,
    calls,
    async dispose() {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function eventTypes(events: RelevantEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("real Pi retry lifecycle characterization", () => {
  it("orders a retryable failure, Pi-managed recovery, and one final settlement", async () => {
    const run = await characterizedSession([
      { kind: "error", message: "WebSocket error: deterministic first attempt" },
      { kind: "text", text: "recovered" },
    ], { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
    try {
      await run.session.prompt("retry once");
      assert.deepEqual(run.events, [
        { type: "agent_start" },
        { type: "message_end", stopReason: "error" },
        { type: "agent_end", stopReason: "error", willRetry: true },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "WebSocket error: deterministic first attempt" },
        { type: "agent_start" },
        { type: "message_end", stopReason: "stop" },
        { type: "auto_retry_end", success: true, attempt: 1 },
        { type: "agent_end", stopReason: "stop", willRetry: false },
        { type: "agent_settled" },
      ]);
    } finally {
      await run.dispose();
    }
  });

  it("keeps retry attempts ordered until recovery", async () => {
    const run = await characterizedSession([
      { kind: "error", message: "fetch failed: attempt one" },
      { kind: "error", message: "fetch failed: attempt two" },
      { kind: "text", text: "recovered" },
    ], { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
    try {
      await run.session.prompt("retry twice");
      assert.deepEqual(run.events.filter((event) => event.type === "agent_end").map((event) => ({ willRetry: event.willRetry, stopReason: event.stopReason })), [
        { willRetry: true, stopReason: "error" },
        { willRetry: true, stopReason: "error" },
        { willRetry: false, stopReason: "stop" },
      ]);
      assert.deepEqual(run.events.filter((event) => event.type === "auto_retry_start"), [
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "fetch failed: attempt one" },
        { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2, errorMessage: "fetch failed: attempt two" },
      ]);
      assert.deepEqual(run.events.filter((event) => event.type === "auto_retry_end"), [
        { type: "auto_retry_end", success: true, attempt: 2 },
      ]);
      assert.equal(eventTypes(run.events).at(-1), "agent_settled");
    } finally {
      await run.dispose();
    }
  });

  it("emits final agent_end before unsuccessful retry-cycle end and settlement when the budget is exhausted", async () => {
    const run = await characterizedSession([
      { kind: "error", message: "503 deterministic attempt one" },
      { kind: "error", message: "503 deterministic attempt two" },
      { kind: "error", message: "503 deterministic terminal attempt" },
    ], { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
    try {
      await run.session.prompt("exhaust retries");
      assert.deepEqual(run.events.slice(-4), [
        { type: "message_end", stopReason: "error" },
        { type: "agent_end", stopReason: "error", willRetry: false },
        { type: "auto_retry_end", success: false, attempt: 2, finalError: "503 deterministic terminal attempt" },
        { type: "agent_settled" },
      ]);
      assert.equal(run.calls.length, 3);
    } finally {
      await run.dispose();
    }
  });

  it("settles a non-retryable error without retry lifecycle events", async () => {
    const run = await characterizedSession([
      { kind: "error", message: "invalid deterministic request" },
    ], { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
    try {
      await run.session.prompt("do not retry");
      assert.deepEqual(run.events, [
        { type: "agent_start" },
        { type: "message_end", stopReason: "error" },
        { type: "agent_end", stopReason: "error", willRetry: false },
        { type: "agent_settled" },
      ]);
      assert.equal(run.calls.length, 1);
    } finally {
      await run.dispose();
    }
  });

  it("ends an aborted retry backoff before the one final settlement", async () => {
    const run = await characterizedSession([
      { kind: "error", message: "WebSocket error before abort" },
      { kind: "text", text: "must not run" },
    ], { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } });
    try {
      let retryStarted!: () => void;
      const started = new Promise<void>((resolve) => { retryStarted = resolve; });
      const unsubscribe = run.session.subscribe((event) => { if (event.type === "auto_retry_start") retryStarted(); });
      const prompt = run.session.prompt("abort during retry backoff");
      await started;
      await run.session.abort();
      await prompt;
      unsubscribe();
      assert.deepEqual(run.events.slice(-3), [
        { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 60_000, errorMessage: "WebSocket error before abort" },
        { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
        { type: "agent_settled" },
      ]);
      assert.equal(run.calls.length, 1);
    } finally {
      await run.dispose();
    }
  });

  it("retries only the failed provider turn after one completed tool effect", async () => {
    let effects = 0;
    const effect = defineTool({
      name: "effect_once",
      label: "Effect once",
      description: "Increment a deterministic counter.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        effects += 1;
        return { content: [{ type: "text" as const, text: "effect completed" }], details: { effects } };
      },
    });
    const run = await characterizedSession([
      { kind: "tool", id: "effect_call_1", name: "effect_once", arguments: {} },
      { kind: "error", message: "fetch failed after completed tool" },
      { kind: "text", text: "recovered without replay" },
    ], { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, tools: [effect] });
    try {
      await run.session.prompt("perform effect then recover");
      assert.equal(effects, 1);
      assert.deepEqual(run.events.filter((event) => event.type === "tool_execution_end"), [
        { type: "tool_execution_end", toolCallId: "effect_call_1", isError: false },
      ]);
      assert.deepEqual(run.events.filter((event) => event.type === "auto_retry_end"), [
        { type: "auto_retry_end", success: true, attempt: 1 },
      ]);
      assert.equal(eventTypes(run.events).at(-1), "agent_settled");
    } finally {
      await run.dispose();
    }
  });

  it("forwards effective trusted settings to Pi provider options and ignores untrusted project settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-retry-settings-characterization-"));
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
        const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
        const run = await characterizedSession([{ kind: "text", text: "settings observed" }], { settingsManager: settings });
        try {
          await run.session.prompt("observe settings");
          assert.deepEqual(run.session.settingsManager.getRetrySettings(), trusted
            ? { enabled: true, maxRetries: 4, baseDelayMs: 5 }
            : { enabled: true, maxRetries: 1, baseDelayMs: 3 });
          assert.deepEqual(run.calls[0], trusted
            ? { transport: "websocket", timeoutMs: 5_555, websocketConnectTimeoutMs: 8_888, maxRetries: 6, maxRetryDelayMs: 6_666 }
            : { transport: "sse", timeoutMs: 1_111, websocketConnectTimeoutMs: 4_444, maxRetries: 2, maxRetryDelayMs: 2_222 });
        } finally {
          await run.dispose();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
