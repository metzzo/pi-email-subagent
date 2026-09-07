import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { SdkWorker } from "../../src/sdk-worker.ts";

for (const contextWindow of [128_000, 5_000]) {
  it(`preserves required instructions or rejects before acceptance with contextWindow=${contextWindow}`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-prompt-budget-"));
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
    let prompt = "";
    let factories = 0;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    runtime.registerProvider("prompt-budget", {
      name: "Prompt Budget", baseUrl: "http://127.0.0.1:9/prompt-budget", apiKey: "deterministic-test-key", api: "prompt-budget",
      models: [{
        id: "budget-model", name: "Budget Model", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: contextWindow,
      }],
      streamSimple(model, context) {
        prompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", content: [{ type: "text", text: "Notification read." }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      },
    });
    const model = runtime.getModel("prompt-budget", "budget-model")!;
    const config = structuredClone(DEFAULT_CONFIG);
    config.modelPolicy = "Use the approved provider only. ".repeat(100);
    config.roles.scout!.instructions = "Do not write outside the assigned scope. ".repeat(100);
    const main = SessionManager.inMemory(root);
    const broker = new AgentBroker({
      cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [model], projectTrusted: false,
      mainAdapter: {
        getAddress: () => "main@budget-model.com", getAliases: () => new Set(["main@budget-model.com"]), isIdle: () => true,
        async deliver({ formatted, envelope }) { main.appendCustomMessageEntry("test.mail", formatted, true, envelope); },
        notifyFailure(message) { main.appendCustomEntry("test.failure", { message }); },
        updateState(snapshot) { main.appendCustomEntry("test.state", snapshot); },
      },
      workerFactory() {
        factories += 1;
        const worker = new SdkWorker(runtime, model);
        worker.subscribe((event) => { if (event.type === "settled") settle(); });
        return worker;
      },
    });
    await broker.init();
    try {
      const send = broker.send(broker.mainAddress, {
        to: "scout.instructions@budget-model.com", subject: "Read constraints", message: "Read this notification.",
        requires_response: false, priority: "low",
      });
      if (contextWindow === 5_000) {
        await assert.rejects(send, /PROMPT_ADDITIONS_TOO_LARGE/);
        assert.equal(factories, 0);
        assert.equal(broker.mailStore.list().length, 0);
        assert.equal(broker.getSnapshot().agents.length, 0);
        assert.equal(broker.getSnapshot().capacity.identitiesUsed, 0);
      } else {
        await send;
        await settled;
        assert.ok(prompt.includes(config.modelPolicy));
        assert.ok(prompt.includes(config.roles.scout!.instructions));
        assert.equal(factories, 1);
      }
    } finally {
      await broker.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}
