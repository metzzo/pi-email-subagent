import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assertCredentialSourceEquivalent,
  inheritRegisteredProviders,
  ProviderReadinessError,
  WorkerRuntimeFactory,
} from "../../src/model-runtime.ts";

type CredentialStatus = Parameters<typeof assertCredentialSourceEquivalent>[1];

const model = {
  provider: "configured-provider",
  id: "model-a",
  api: "openai-responses",
  compat: { supportsLongCacheRetention: false },
};

function sourceRegistry(
  status: CredentialStatus = { configured: true, source: "stored" },
): ModelRegistry {
  const config = { api: "custom-api", baseUrl: "https://example.invalid", models: [] };
  const native = { id: "native-provider" };
  return {
    getAll: () => [model],
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getRegisteredProviderIds: () => ["configured-provider", "native-provider", "missing-provider"],
    getRegisteredProviderConfig: (id: string) => id === "configured-provider" ? config : undefined,
    getRegisteredNativeProvider: (id: string) => id === "native-provider" ? native : undefined,
    getProviderAuthStatus: () => status,
  } as unknown as ModelRegistry;
}

function targetRuntime(
  status: CredentialStatus = { configured: true, source: "stored" },
  runtimeModel: typeof model = model,
): ModelRuntime {
  return {
    registerProvider() {},
    registerNativeProvider() {},
    getModel: (provider: string, id: string) => provider === runtimeModel.provider && id === runtimeModel.id ? runtimeModel : undefined,
    getProviderAuthStatus: () => status,
    getAuth: async () => { throw new Error("secret resolution must not be used for equivalence"); },
  } as unknown as ModelRuntime;
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

  it("allows only supported matching non-secret credential source classes", () => {
    for (const source of ["stored", "models_json_key"] as const) {
      assert.doesNotThrow(() => assertCredentialSourceEquivalent(
        "configured-provider",
        { configured: true, source },
        { configured: true, source },
      ));
    }
    assert.doesNotThrow(() => assertCredentialSourceEquivalent(
      "configured-provider",
      { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" },
      { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" },
    ));
  });

  it("fails closed for runtime overrides, commands, fallbacks, mismatches, and indeterminate auth", () => {
    const rejected: Array<[CredentialStatus, CredentialStatus]> = [
      [{ configured: true, source: "runtime" }, { configured: true, source: "stored" }],
      [{ configured: true, source: "runtime" }, { configured: false }],
      [{ configured: true, source: "models_json_command" }, { configured: true, source: "models_json_command" }],
      [{ configured: true, source: "fallback" }, { configured: true, source: "fallback" }],
      [{ configured: true, source: "environment", label: "PARENT_KEY" }, { configured: true, source: "stored" }],
      [{ configured: true, source: "environment", label: "PARENT_KEY" }, { configured: true, source: "environment", label: "WORKER_KEY" }],
      [{ configured: true }, { configured: true }],
      [{ configured: false }, { configured: false }],
    ];
    for (const [parent, worker] of rejected) {
      assert.throws(
        () => assertCredentialSourceEquivalent("configured-provider", parent, worker),
        ProviderReadinessError,
      );
    }
  });

  it("creates a provider snapshot without resolving or comparing credential material", async () => {
    const target = targetRuntime();
    const factory = new WorkerRuntimeFactory(
      sourceRegistry(),
      { authPath: "/agent/auth.json", modelsPath: "/agent/models.json" },
      async () => target,
    );

    const snapshot = await factory.create("configured-provider", "model-a");
    assert.equal(snapshot.runtime, target);
    assert.equal(snapshot.model, model);
  });

  it("allows stored OAuth and matching environment status without inspecting credentials", async () => {
    const statuses: CredentialStatus[] = [
      { configured: true, source: "stored" },
      { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" },
      { configured: true, source: "models_json_key" },
    ];
    for (const status of statuses) {
      const factory = new WorkerRuntimeFactory(sourceRegistry(status), {}, async () => targetRuntime(status));
      await assert.doesNotReject(factory.preflight("configured-provider", "model-a"));
    }
  });

  it("rejects unsupported source classes before any model request or secret resolution", async () => {
    const statuses: CredentialStatus[] = [
      { configured: true, source: "runtime" },
      { configured: true, source: "models_json_command" },
      { configured: true, source: "fallback" },
    ];
    for (const status of statuses) {
      const factory = new WorkerRuntimeFactory(sourceRegistry(status), {}, async () => targetRuntime(status));
      await assert.rejects(
        factory.preflight("configured-provider", "model-a"),
        /credential source.*configured-provider.*unsupported/i,
      );
    }
  });

  it("requires reload after source class or long-cache compatibility metadata changes", async () => {
    const parentStatus: CredentialStatus = { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" };
    const source = sourceRegistry(parentStatus);
    const changedStatus: CredentialStatus = { configured: true, source: "stored" };
    const changedModel = { ...model, compat: { supportsLongCacheRetention: true } };
    const factory = new WorkerRuntimeFactory(source, {}, async () => targetRuntime(changedStatus));

    await assert.rejects(
      factory.create("configured-provider", "model-a"),
      /credential source.*environment.*stored.*reload/i,
    );

    const sameSourceFactory = new WorkerRuntimeFactory(source, {}, async () => targetRuntime(parentStatus, changedModel));
    await assert.rejects(
      sameSourceFactory.create("configured-provider", "model-a"),
      /compatibility metadata.*long cache retention.*reload/i,
    );
  });

  it("keeps readiness diagnostics to provider and source classes", async () => {
    const parent: CredentialStatus = { configured: true, source: "environment", label: "SENTINEL_PARENT_CREDENTIAL_LABEL" };
    const worker: CredentialStatus = { configured: true, source: "environment", label: "SENTINEL_WORKER_CREDENTIAL_LABEL" };
    const factory = new WorkerRuntimeFactory(sourceRegistry(parent), {}, async () => targetRuntime(worker));
    let error: unknown;
    try {
      await factory.create("configured-provider", "model-a");
      assert.fail("expected readiness rejection");
    } catch (failure) {
      error = failure;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /configured-provider.*environment/i);
    assert.doesNotMatch(error.message, /SENTINEL|CREDENTIAL_LABEL|https?:|authorization|bearer/i);
  });

  it("fails clearly when the exact selected model is absent", async () => {
    const noModels = {
      registerProvider() {},
      registerNativeProvider() {},
      getModel: () => undefined,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    } as unknown as ModelRuntime;
    await assert.rejects(
      new WorkerRuntimeFactory(sourceRegistry(), {}, async () => noModels).create("configured-provider", "missing"),
      /model configured-provider\/missing is not available in the worker runtime snapshot/i,
    );
  });
});
