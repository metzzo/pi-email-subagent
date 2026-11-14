import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { SdkWorker } from "../../src/sdk-worker.ts";
import { WorkerSettingsSnapshot } from "../../src/settings-snapshot.ts";
import type { LlmAgentRecord } from "../../src/types.ts";
import type { WorkerExtensionRegistration } from "../../src/worker-extensions.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settledPrompt(worker: SdkWorker, message: string) {
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = worker.subscribe((event) => {
      if (event.type === "settled") { unsubscribe(); resolve(); }
    });
  });
  await worker.prompt(message);
  await settled;
}

describe("Pi prompt preflight cleanup ownership", () => {
  for (const operation of ["cleanup", "dispose"] as const) {
    it(`${operation} joins real Pi preflight and vetoes the old run before a persisted replacement runs`, { timeout: 30_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-email-real-preflight-"));
      const entered = deferred();
      const release = deferred();
      let providerStarts = 0;
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
      runtime.registerProvider("preflight-probe", {
        api: "preflight-probe", apiKey: "deterministic-test-key", baseUrl: "http://127.0.0.1:9/preflight-probe",
        models: [{ id: "preflight-model", name: "Preflight Model", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000 }],
        streamSimple(model) {
          providerStarts += 1;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "Real generation completed." }],
            api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
          return stream;
        },
      });
      const model = runtime.getModel("preflight-probe", "preflight-model")!;
      const now = new Date().toISOString();
      const record: LlmAgentRecord = {
        kind: "llm", address: "reader.preflight@preflight-model.com", name: "reader", taskSlug: "preflight",
        provider: model.provider, modelId: model.id, effort: "low", tools: ["read", "send_email", "fetch_emails"],
        state: "paused", createdAt: now, updatedAt: now, enforcementAttempts: 0, lifecycle: { ...DEFAULT_LIFECYCLE },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, activity: [],
      };
      let preparations = 0;
      const registration: WorkerExtensionRegistration = {
        protocolVersion: 2, name: "real-preflight-gate", tools: [], effects: {},
        factory(pi) {
          pi.on("before_agent_start", async () => {
            if (++preparations === 2) { entered.resolve(); await release.promise; }
          });
        },
      };
      const snapshot = WorkerSettingsSnapshot.capture(root, root, false);
      const oldWorker = new SdkWorker(runtime, model, snapshot, [registration]);
      let replacement: SdkWorker | undefined;
      const start = (worker: SdkWorker, workerRecord: LlmAgentRecord) => worker.start({
        record: workerRecord, model, cwd: root, agentDir: root, sessionDir: join(root, "sessions"), projectTrusted: false,
        systemPrompt: "Use only this exact worker generation.",
        sendEmail: async () => { throw new Error("provider never calls mail tools"); },
        fetchEmails: () => ({ emails: [], total: 0 }),
      });
      try {
        await start(oldWorker, record);
        await settledPrompt(oldWorker, "Create a genuine persisted session");
        assert.equal(providerStarts, 1);
        const sessionFile = oldWorker.getSessionFile();
        assert.ok(sessionFile);
        const promptOutcome = oldWorker.prompt("Hold the old run in real Pi preflight").then(() => "resolved", () => "rejected");
        await entered.promise;
        let stopped = false;
        const stopping = oldWorker[operation]().then(() => { stopped = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stopped, false, "cleanup must retain ownership while real preflight is pending");
        release.resolve();
        await stopping;
        assert.equal(await promptOutcome, "rejected");
        assert.equal(providerStarts, 1, "the cancelled old prompt never reaches the model");
        replacement = new SdkWorker(runtime, model, snapshot);
        await start(replacement, oldWorker.getSnapshot().record);
        assert.equal(replacement.getSessionFile(), sessionFile, "replacement resumes the genuine session");
        await settledPrompt(replacement, "Only the replacement may run");
        assert.equal(providerStarts, 2, "only the replacement adds a model request");
      } finally {
        release.resolve();
        await oldWorker.dispose();
        await replacement?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
