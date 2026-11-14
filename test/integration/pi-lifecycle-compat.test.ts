import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

it("keeps coordinator guidance through real user, custom-message and explicit user-message runs", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-compat-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const guidance: string[] = [];
  const starts: Array<{ messageType: unknown; idle: boolean }> = [];
  const errors: unknown[] = [];
  let api: ExtensionAPI | undefined;
  let onSettled: (() => void) | undefined;
  let settlements = 0;
  runtime.registerProvider("lifecycle-probe", {
    api: "lifecycle-probe", apiKey: "deterministic-test-key", baseUrl: "http://127.0.0.1:9/lifecycle-probe",
    models: [{ id: "lifecycle-model", name: "Lifecycle Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000 }],
    streamSimple(model, context) {
      guidance.push(getCurrentSystemMessage(context.messages)?.sections?.email_coordination ?? "");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Lifecycle observed." }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [resolve("src/index.ts")],
    extensionFactories: [(pi) => {
      api = pi;
      pi.on("before_agent_start", (event, ctx) => {
        starts.push({ messageType: "messageType" in event ? event.messageType : undefined, idle: ctx.isIdle() });
      });
      pi.on("agent_settled", () => { settlements += 1; onSettled?.(); });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("lifecycle-probe", "lifecycle-model")!,
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error); } });
    await session.prompt("First user run");
    assert.ok(api);
    const customSettled = new Promise<void>((resolve) => { onSettled = resolve; });
    api.sendMessage({ customType: "lifecycle-probe", content: "Automatic mail-like turn", display: false }, { triggerTurn: true, deliverAs: "followUp" });
    await customSettled;
    const userSettled = new Promise<void>((resolve) => { onSettled = resolve; });
    api.sendUserMessage("Explicit user message", { deliverAs: "followUp" });
    await userSettled;
    assert.equal(settlements, 3, "agent_settled observes each completed run");
    assert.equal(guidance.length, 3);
    for (const prompt of guidance) assert.match(prompt, /Virtual Agent Email[\s\S]*main@lifecycle-model\.com/);
    if (starts[0]?.messageType === "user") {
      assert.deepEqual(starts.map((event) => event.messageType), ["user", "custom", "user"]);
      assert.ok(starts.every((event) => !event.idle), "new hosts are busy during run startup");
    } else {
      assert.equal(starts.length, 2, "older hosts skip before_agent_start for custom runs; context hook restores guidance");
    }
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    await session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
