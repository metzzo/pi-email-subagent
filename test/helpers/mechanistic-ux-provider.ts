import { appendFileSync, existsSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Minimal local model boundary: record every generation call. Direct commands
// must never reach it. A single deliberate user turn can hold Pi genuinely busy.
export default function (pi: ExtensionAPI): void {
  pi.registerProvider("ux-local", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "local-test-only",
    models: [{ id: "ux-local", name: "UX local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      appendFileSync(process.env.UX_MODEL_CALLS!, "generation\n");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Explicit user turn complete" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      void (async () => {
        while (process.env.UX_RELEASE_FILE && !existsSync(process.env.UX_RELEASE_FILE) && !options?.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      })();
      return stream;
    },
  });
}
