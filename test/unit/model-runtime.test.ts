import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { inheritRegisteredProviders, WorkerRuntimeFactory } from "../../src/model-runtime.ts";

function sourceRegistry(): ModelRegistry {
  const config = { api: "custom-api", baseUrl: "https://example.invalid", models: [] };
  const native = { id: "native-provider" };
  return {
    getRegisteredProviderIds: () => ["configured-provider", "native-provider", "missing-provider"],
    getRegisteredProviderConfig: (id: string) => id === "configured-provider" ? config : undefined,
    getRegisteredNativeProvider: (id: string) => id === "native-provider" ? native : undefined,
  } as unknown as ModelRegistry;
}

describe("worker model runtime", () => {
  it("inherits custom and native providers registered in the parent session", () => {
    const configured: Array<[string, unknown]> = [];
    const native: unknown[] = [];
    const target = {
      registerProvider: (id: string, config: unknown) => configured.push([id, config]),
      registerNativeProvider: (provider: unknown) => native.push(provider),
    } as unknown as ModelRuntime;

    inheritRegisteredProviders(sourceRegistry(), target);

    assert.deepEqual(configured, [[
      "configured-provider",
      { api: "custom-api", baseUrl: "https://example.invalid", models: [] },
    ]]);
    assert.deepEqual(native, [{ id: "native-provider" }]);
  });

  it("creates a provider snapshot and resolves an authenticated worker model", async () => {
    const model = { provider: "configured-provider", id: "model-a" };
    const target = {
      registerProvider() {},
      registerNativeProvider() {},
      getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAuth: async () => ({ auth: { type: "api_key", key: "persistent" } }),
    } as unknown as ModelRuntime;
    const source = {
      ...sourceRegistry(),
      getProviderAuth: async () => ({ auth: { type: "api_key", key: "parent" } }),
    } as unknown as ModelRegistry;
    const factory = new WorkerRuntimeFactory(source, { authPath: "/agent/auth.json", modelsPath: "/agent/models.json" }, async () => target);

    const snapshot = await factory.create("configured-provider", "model-a");
    assert.equal(snapshot.runtime, target);
    assert.equal(snapshot.model, model);
  });

  it("fails clearly when a selected model or parent runtime-only auth cannot transfer", async () => {
    const source = {
      ...sourceRegistry(),
      getProviderAuth: async () => ({ auth: { type: "api_key", key: "runtime-only" } }),
    } as unknown as ModelRegistry;
    const noModels = {
      registerProvider() {}, registerNativeProvider() {}, getModel: () => undefined,
    } as unknown as ModelRuntime;
    await assert.rejects(
      new WorkerRuntimeFactory(source, {}, async () => noModels).create("configured-provider", "missing"),
      /model configured-provider\/missing is not available in the worker runtime snapshot/i,
    );

    const noAuth = {
      registerProvider() {},
      registerNativeProvider() {},
      getModel: () => ({ provider: "configured-provider", id: "model-a" }),
      getAuth: async () => undefined,
    } as unknown as ModelRuntime;
    await assert.rejects(
      new WorkerRuntimeFactory(source, {}, async () => noAuth).create("configured-provider", "model-a"),
      /authentication.*available only in the parent runtime.*persist.*reload/i,
    );
  });
});
