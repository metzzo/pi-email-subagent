import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkerRuntimeFactory } from "../../src/model-runtime.ts";

type PerLevelSampling = { low: { temperature: number } };
const provider = "sampling-readiness";
const modelId = "sampling-model";

async function withRuntimeConfig(
  run: (fixture: {
    writeConfig: (perLevel?: PerLevelSampling | null, temperature?: number) => Promise<void>;
    createFactory: () => Promise<{ runtime: ModelRuntime; factory: WorkerRuntimeFactory }>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sampling-"));
  const options = {
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store"),
  };
  try {
    await run({
      async writeConfig(perLevel: PerLevelSampling | null = { low: { temperature: 0.2 } }, temperature = 0.3) {
        await writeFile(options.modelsPath, JSON.stringify({
          providers: {
            [provider]: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "sampling-readiness-test-key",
              models: [{
                id: modelId,
                name: "Sampling readiness model",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 2_000,
                samplingParams: { temperature },
                ...(perLevel === null ? {} : { samplingParamsByThinkingLevel: perLevel }),
              }],
            },
          },
        }));
      },
      async createFactory() {
        const runtime = await ModelRuntime.create(options);
        return { runtime, factory: new WorkerRuntimeFactory(new ModelRegistry(runtime), options) };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("preserves ordinary sampling readiness checks with real model configuration reloads", async () => {
  await withRuntimeConfig(async ({ writeConfig, createFactory }) => {
    await writeConfig();
    const { factory } = await createFactory();
    const unchanged = await factory.preflight(provider, modelId);
    assert.equal(unchanged.model.samplingParams?.temperature, 0.3);
    await writeConfig({ low: { temperature: 0.2 } }, 0.8);
    await assert.rejects(factory.preflight(provider, modelId), /request metadata differs.*reload/i);
  });
});

it("preserves and deeply freezes unchanged per-thinking-level sampling in a real worker snapshot", async (t) => {
  await withRuntimeConfig(async ({ writeConfig, createFactory }) => {
    await writeConfig();
    const { runtime, factory } = await createFactory();
    const parent = runtime.getModel(provider, modelId)!;
    if (!("samplingParamsByThinkingLevel" in parent)) {
      t.skip("host does not expose per-thinking-level sampling");
      return;
    }
    const snapshot = await factory.preflight(provider, modelId);
    assert.ok("samplingParamsByThinkingLevel" in snapshot.model);
    const sampling = snapshot.model.samplingParamsByThinkingLevel as PerLevelSampling;
    assert.deepEqual(sampling, { low: { temperature: 0.2 } });
    assert.equal(Object.isFrozen(sampling), true);
    assert.equal(Object.isFrozen(sampling.low), true);
    assert.notEqual(sampling, parent.samplingParamsByThinkingLevel);
    assert.notEqual(sampling, (snapshot.runtime.getModel(provider, modelId)! as typeof parent).samplingParamsByThinkingLevel);
  });
});

for (const change of ["nested change", "addition", "removal"] as const) {
  it(`rejects per-thinking-level sampling ${change} after the startup snapshot with real runtimes`, async (t) => {
    await withRuntimeConfig(async ({ writeConfig, createFactory }) => {
      await writeConfig();
      const { runtime } = await createFactory();
      if (!("samplingParamsByThinkingLevel" in runtime.getModel(provider, modelId)!)) {
        t.skip("host does not expose per-thinking-level sampling");
        return;
      }
      const initial = change === "addition" ? null : { low: { temperature: 0.2 } };
      const updated = change === "removal" ? null : { low: { temperature: 0.9 } };
      await writeConfig(initial);
      const { factory } = await createFactory();
      await writeConfig(updated);
      await assert.rejects(factory.preflight(provider, modelId), /request metadata differs.*reload/i);
    });
  });
}
