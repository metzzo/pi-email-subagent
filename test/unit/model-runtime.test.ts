import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assertCredentialSourceEquivalent,
  ProviderReadinessError,
  WorkerRuntimeFactory,
} from "../../src/model-runtime.ts";
import { fakeModel } from "../helpers/fakes.ts";

type CredentialStatus = Parameters<typeof assertCredentialSourceEquivalent>[1];

const model = {
  ...fakeModel("model-a", "builtin-provider"),
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  thinkingLevelMap: { low: "low", high: "high" },
  input: ["text"] as ("text" | "image")[],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 128_000,
  maxTokens: 32_000,
  compat: { supportsLongCacheRetention: false, supportsToolSearch: true },
} as Model<any>;

function sourceRegistry(
  status: CredentialStatus = { configured: true, source: "stored" },
  sourceModel: Model<any> = model,
  registered: readonly string[] = [],
): ModelRegistry {
  return {
    getAll: () => [sourceModel],
    getRegisteredProviderIds: () => registered,
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: () => undefined,
    getProviderAuthStatus: () => status,
  } as unknown as ModelRegistry;
}

function targetRuntime(
  status: CredentialStatus = { configured: true, source: "stored" },
  runtimeModel: Model<any> = structuredClone(model),
): ModelRuntime {
  return {
    getModel: (provider: string, id: string) => provider === runtimeModel.provider && id === runtimeModel.id ? runtimeModel : undefined,
    getProviderAuthStatus: () => status,
    getAuth: async () => { throw new Error("secret resolution must not be used for equivalence"); },
  } as unknown as ModelRuntime;
}

describe("worker model runtime", () => {
  it("allows only supported matching non-secret credential source classes", () => {
    for (const source of ["stored", "models_json_key"] as const) {
      assert.doesNotThrow(() => assertCredentialSourceEquivalent(
        "builtin-provider",
        { configured: true, source },
        { configured: true, source },
      ));
    }
    assert.doesNotThrow(() => assertCredentialSourceEquivalent(
      "builtin-provider",
      { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" },
      { configured: true, source: "environment", label: "FIXTURE_PROVIDER_KEY" },
    ));
  });

  it("fails closed for runtime overrides, commands, fallbacks, mismatches, and indeterminate auth", () => {
    const rejected: Array<[CredentialStatus, CredentialStatus]> = [
      [{ configured: true, source: "runtime" }, { configured: true, source: "stored" }],
      [{ configured: true, source: "models_json_command" }, { configured: true, source: "models_json_command" }],
      [{ configured: true, source: "fallback" }, { configured: true, source: "fallback" }],
      [{ configured: true, source: "environment", label: "PARENT_KEY" }, { configured: true, source: "stored" }],
      [{ configured: true, source: "environment", label: "PARENT_KEY" }, { configured: true, source: "environment", label: "WORKER_KEY" }],
      [{ configured: true }, { configured: true }],
      [{ configured: false }, { configured: false }],
    ];
    for (const [parent, worker] of rejected) {
      assert.throws(() => assertCredentialSourceEquivalent("builtin-provider", parent, worker), ProviderReadinessError);
    }
  });

  it("prepares one exact frozen request model without resolving or comparing secret material", async () => {
    const runtimeModel = structuredClone(model);
    const runtime = targetRuntime({ configured: true, source: "stored" }, runtimeModel);
    const snapshot = await new WorkerRuntimeFactory(sourceRegistry(), {}, async () => runtime)
      .preflight("builtin-provider", "model-a");
    assert.equal(snapshot.runtime, runtime);
    assert.equal(snapshot.model, runtimeModel);
    assert.equal(Object.isFrozen(snapshot.model), true);
    assert.equal(Object.isFrozen(snapshot.model.compat), true);
  });

  it("rejects drift in every non-secret request-affecting model field", async () => {
    const changes: Array<[string, (value: any) => void]> = [
      ["baseUrl", (value) => { value.baseUrl = "https://drift.invalid"; }],
      ["reasoning", (value) => { value.reasoning = false; }],
      ["thinking map", (value) => { value.thinkingLevelMap.high = "xhigh"; }],
      ["input", (value) => { value.input = ["text", "image"]; }],
      ["cost", (value) => { value.cost.input = 9; }],
      ["context", (value) => { value.contextWindow = 64_000; }],
      ["max tokens", (value) => { value.maxTokens = 8_000; }],
      ["compat", (value) => { value.compat.supportsToolSearch = false; }],
      ["api", (value) => { value.api = "openai-completions"; }],
    ];
    for (const [label, mutate] of changes) {
      const changed = structuredClone(model) as any;
      mutate(changed);
      await assert.rejects(
        new WorkerRuntimeFactory(sourceRegistry(), {}, async () => targetRuntime(undefined, changed))
          .create("builtin-provider", "model-a"),
        /request metadata differs.*reload/i,
        label,
      );
    }
  });

  it("rejects header provenance and extension-registered provider hooks without exposing values", async () => {
    const withHeaders = { ...structuredClone(model), headers: { authorization: "SENTINEL_SECRET_HEADER" } } as Model<any>;
    assert.throws(
      () => new WorkerRuntimeFactory(sourceRegistry(undefined, withHeaders), {}, async () => targetRuntime()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /header.*provenance.*cannot be proven/i);
        assert.doesNotMatch(error.message, /SENTINEL_SECRET_HEADER|authorization/i);
        return true;
      },
    );

    let created = false;
    const factory = new WorkerRuntimeFactory(
      sourceRegistry(undefined, model, ["builtin-provider"]),
      {},
      async () => { created = true; return targetRuntime(); },
    );
    await assert.rejects(factory.create("builtin-provider", "model-a"), /extension-registered.*readiness receipt.*no email was accepted/i);
    assert.equal(created, false, "custom hooks are not replayed into a worker runtime");
  });

  it("rejects unsupported source classes before a model request", async () => {
    for (const source of ["runtime", "models_json_command", "fallback"] as const) {
      const status: CredentialStatus = { configured: true, source };
      const factory = new WorkerRuntimeFactory(sourceRegistry(status), {}, async () => targetRuntime(status));
      await assert.rejects(factory.preflight("builtin-provider", "model-a"), /credential source.*unsupported/i);
    }
  });

  it("keeps readiness diagnostics to provider and source classes", async () => {
    const parent: CredentialStatus = { configured: true, source: "environment", label: "SENTINEL_PARENT_CREDENTIAL_LABEL" };
    const worker: CredentialStatus = { configured: true, source: "environment", label: "SENTINEL_WORKER_CREDENTIAL_LABEL" };
    await assert.rejects(
      new WorkerRuntimeFactory(sourceRegistry(parent), {}, async () => targetRuntime(worker))
        .create("builtin-provider", "model-a"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /builtin-provider.*environment/i);
        assert.doesNotMatch(error.message, /SENTINEL|CREDENTIAL_LABEL|https?:|authorization|bearer/i);
        return true;
      },
    );
  });

  it("fails clearly when the exact selected model is absent", async () => {
    const noModels = {
      getModel: () => undefined,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    } as unknown as ModelRuntime;
    await assert.rejects(
      new WorkerRuntimeFactory(sourceRegistry(), {}, async () => noModels).create("builtin-provider", "missing"),
      /model builtin-provider\/missing is not available/i,
    );
  });
});
