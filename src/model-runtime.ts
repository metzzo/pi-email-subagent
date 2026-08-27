import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { CreateModelRuntimeOptions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface WorkerRuntimeSnapshot {
  runtime: ModelRuntime;
  /** Exact frozen model object used by worker execution. */
  model: Model<Api>;
}

type RuntimeCreator = (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
type AuthStatus = ReturnType<ModelRegistry["getProviderAuthStatus"]>;

type RequestModelSnapshot = Omit<Model<Api>, "headers">;
type NativeProvider = NonNullable<ReturnType<ModelRegistry["getRegisteredNativeProvider"]>>;
type ConfiguredProvider = NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
type RegisteredProvider = { kind: "native"; provider: NativeProvider } | { kind: "configured"; config: ConfiguredProvider };

function statusClass(status: AuthStatus): string {
  if (!status.configured) return "unconfigured";
  return status.source ?? "indeterminate";
}

/** A content-safe deterministic readiness failure; no credential label or material is retained. */
export class ProviderReadinessError extends Error {
  constructor(
    readonly providerId: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderReadinessError";
  }
}

/**
 * Enforce only the credential-source equivalence Pi 0.84.2 can prove without
 * resolving, comparing, copying, or logging credential material.
 */
export function assertCredentialSourceEquivalent(
  providerId: string,
  parent: AuthStatus,
  worker: AuthStatus,
): void {
  const parentClass = statusClass(parent);
  const workerClass = statusClass(worker);
  const correction = "Correct Pi provider authentication, then reload the extension.";

  if (!parent.configured || !worker.configured || !parent.source || !worker.source) {
    throw new ProviderReadinessError(
      providerId,
      "credential-source-indeterminate",
      `Credential source for provider ${providerId} is indeterminate for isolated workers (parent: ${parentClass}; worker: ${workerClass}). ${correction}`,
    );
  }
  if (parent.source !== worker.source) {
    throw new ProviderReadinessError(
      providerId,
      "credential-source-mismatch",
      `Credential source for provider ${providerId} is incompatible with the extension-start snapshot (parent: ${parentClass}; worker: ${workerClass}). ${correction}`,
    );
  }
  if (parent.source === "environment" && (!parent.label || !worker.label || parent.label !== worker.label)) {
    throw new ProviderReadinessError(
      providerId,
      "credential-environment-context-mismatch",
      `Credential source for provider ${providerId} is environment in both runtimes, but its non-secret source context differs. ${correction}`,
    );
  }
  if (parent.source !== "stored" && parent.source !== "environment" && parent.source !== "models_json_key") {
    throw new ProviderReadinessError(
      providerId,
      "credential-source-unsupported",
      `Credential source for provider ${providerId} is unsupported for isolated workers (parent: ${parentClass}; worker: ${workerClass}). ${correction}`,
    );
  }
}

function hasModelHeaders(model: Model<Api>): boolean {
  return Boolean(model.headers && Object.keys(model.headers).length > 0);
}

function headerProvenanceError(providerId: string, modelId: string): ProviderReadinessError {
  return new ProviderReadinessError(
    providerId,
    "model-header-provenance-unavailable",
    `Model ${providerId}/${modelId} uses request headers whose non-secret provenance cannot be proven by Pi 0.84.2. Remove those headers or use the main session; no email was accepted.`,
  );
}

function nativeProviderPolicyUnavailable(providerId: string): ProviderReadinessError {
  return new ProviderReadinessError(
    providerId,
    "native-provider-policy-unavailable",
    `Native provider ${providerId} depends on dynamic OAuth/catalog/header policy that cannot be proven self-contained for an isolated Pi 0.84.2 worker; no email was accepted.`,
  );
}

function assertStaticNativeProvider(providerId: string, provider: NativeProvider): void {
  if ((provider.headers && Object.keys(provider.headers).length > 0)
    || provider.auth.oauth
    || provider.refreshModels
    || provider.filterModels) {
    throw nativeProviderPolicyUnavailable(providerId);
  }
}

function requestModelSnapshot(model: Model<Api>): RequestModelSnapshot {
  const {
    id,
    name,
    api,
    provider,
    baseUrl,
    reasoning,
    thinkingLevelMap,
    input,
    cost,
    contextWindow,
    maxTokens,
    samplingParams,
    compat,
  } = model;
  return structuredClone({
    id,
    name,
    api,
    provider,
    baseUrl,
    reasoning,
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    input,
    cost,
    contextWindow,
    maxTokens,
    ...(samplingParams !== undefined ? { samplingParams } : {}),
    ...(compat !== undefined ? { compat } : {}),
  }) as RequestModelSnapshot;
}

function freezeRequestModel<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freezeRequestModel(nested);
  return Object.freeze(value);
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * Prepares one exact isolated runtime/model request object. Self-contained
 * native/static configured providers are registered as the same public provider
 * object/config and their pending refresh is joined through getAvailable().
 * Dynamic OAuth/catalog/header policy remains fail-closed.
 */
export class WorkerRuntimeFactory {
  private readonly registeredProviders = new Map<string, RegisteredProvider>();
  private readonly parentAuth = new Map<string, AuthStatus>();
  private readonly headerModels = new Set<string>();
  private readonly requestModels = new Map<string, RequestModelSnapshot>();

  constructor(
    private readonly source: ModelRegistry,
    private readonly options: CreateModelRuntimeOptions,
    private readonly createRuntime: RuntimeCreator = PiCodingAgent.ModelRuntime.create,
  ) {
    for (const id of source.getRegisteredProviderIds()) {
      const native = source.getRegisteredNativeProvider(id);
      if (native) this.registeredProviders.set(id, { kind: "native", provider: native });
      else {
        const config = source.getRegisteredProviderConfig(id);
        if (config) this.registeredProviders.set(id, { kind: "configured", config });
      }
    }
    for (const model of source.getAll()) {
      if (!this.parentAuth.has(model.provider)) {
        this.parentAuth.set(model.provider, { ...source.getProviderAuthStatus(model.provider) });
      }
      const key = modelKey(model.provider, model.id);
      if (hasModelHeaders(model)) this.headerModels.add(key);
      this.requestModels.set(key, requestModelSnapshot(model));
    }
  }

  async preflight(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    return this.create(providerId, modelId);
  }

  async create(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    const key = modelKey(providerId, modelId);
    if (this.headerModels.has(key)) throw headerProvenanceError(providerId, modelId);
    const registered = this.registeredProviders.get(providerId);
    if (registered?.kind === "native") assertStaticNativeProvider(providerId, registered.provider);
    if (registered?.kind === "configured") {
      const config = registered.config;
      if (config.oauth || config.refreshModels
        || (config.headers && Object.keys(config.headers).length > 0)
        || config.models?.some((candidate) => candidate.headers && Object.keys(candidate.headers).length > 0)) {
        throw new ProviderReadinessError(
          providerId,
          "registered-provider-policy-unavailable",
          `Provider ${providerId} depends on dynamic OAuth/catalog/header policy that cannot be proven self-contained for an isolated Pi 0.84.2 worker; no email was accepted.`,
        );
      }
    }

    let runtime: ModelRuntime;
    let available: readonly Model<Api>[] | undefined;
    try {
      runtime = await this.createRuntime(this.options);
      if (registered?.kind === "native") runtime.registerNativeProvider(registered.provider);
      else if (registered?.kind === "configured") runtime.registerProvider(providerId, registered.config);
      // registerProvider/registerNativeProvider start an internal refresh without
      // returning it. Public getAvailable() coalesces that exact pending refresh,
      // so readiness is not declared from the provisional snapshot.
      if (registered) available = await runtime.getAvailable(providerId);
    } catch {
      throw new ProviderReadinessError(
        providerId,
        "runtime-snapshot-unavailable",
        `Worker runtime snapshot for provider ${providerId} could not be created. Correct provider/model configuration, then reload the extension.`,
      );
    }

    if (registered && !available?.some((candidate) => candidate.provider === providerId && candidate.id === modelId)) {
      throw new ProviderReadinessError(
        providerId,
        "registered-model-not-available",
        `Registered provider ${providerId}'s exact model ${providerId}/${modelId} was not in the joined available set. Correct provider authentication/catalog policy, then reload the extension.`,
      );
    }

    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      throw new ProviderReadinessError(
        providerId,
        "model-unavailable",
        `Model ${providerId}/${modelId} is not available in the worker runtime snapshot. Reload the extension after changing provider or model configuration.`,
      );
    }

    const parentRequest = this.requestModels.get(key);
    if (!parentRequest) {
      throw new ProviderReadinessError(
        providerId,
        "model-snapshot-missing",
        `Model ${providerId}/${modelId} was not present in the extension-start model snapshot. Reload the extension.`,
      );
    }
    if (hasModelHeaders(model)) throw headerProvenanceError(providerId, modelId);
    const workerRequest = requestModelSnapshot(model);
    if (!isDeepStrictEqual(parentRequest, workerRequest)) {
      throw new ProviderReadinessError(
        providerId,
        "model-request-metadata-mismatch",
        `Model ${providerId}/${modelId} request metadata differs from the extension-start snapshot. API, endpoint, reasoning/thinking, input, cost, context/output limits, sampling parameters, or compatibility policy changed; reload the extension.`,
      );
    }

    const parentStatus = this.parentAuth.get(providerId) ?? { configured: false };
    const workerStatus = runtime.getProviderAuthStatus(providerId);
    assertCredentialSourceEquivalent(providerId, parentStatus, workerStatus);

    // This is the exact object passed to createAgentSession; no second runtime
    // or model lookup occurs after mail admission.
    return { runtime, model: freezeRequestModel(model) };
  }
}
