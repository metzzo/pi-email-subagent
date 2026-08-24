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
 * Enforce only the credential-source equivalence Pi 0.81.1 can prove without
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

function requestModelSnapshot(model: Model<Api>, providerId: string): RequestModelSnapshot {
  // Pi 0.81.1 exposes resolved model headers but no public provenance that can
  // distinguish static non-secret metadata from command/hook/secret-derived
  // values. Do not compare or retain those values: narrow the route instead.
  if (model.headers && Object.keys(model.headers).length > 0) {
    throw new ProviderReadinessError(
      providerId,
      "model-header-provenance-unavailable",
      `Model ${providerId}/${model.id} uses request headers whose non-secret provenance cannot be proven by Pi 0.81.1. Remove those headers or use the main session; no email was accepted.`,
    );
  }
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
 * Prepares one exact isolated runtime/model request object. Extension-registered
 * providers are deliberately unsupported: Pi 0.81.1 registration starts an
 * unacknowledged auth/availability refresh and custom hooks cannot be replayed
 * into a self-contained worker without changing request policy.
 */
export class WorkerRuntimeFactory {
  private readonly registeredProviderIds: ReadonlySet<string>;
  private readonly parentAuth = new Map<string, AuthStatus>();
  private readonly requestModels = new Map<string, RequestModelSnapshot>();

  constructor(
    private readonly source: ModelRegistry,
    private readonly options: CreateModelRuntimeOptions,
    private readonly createRuntime: RuntimeCreator = PiCodingAgent.ModelRuntime.create,
  ) {
    this.registeredProviderIds = new Set(source.getRegisteredProviderIds());
    for (const model of source.getAll()) {
      if (!this.parentAuth.has(model.provider)) {
        this.parentAuth.set(model.provider, { ...source.getProviderAuthStatus(model.provider) });
      }
      this.requestModels.set(modelKey(model.provider, model.id), requestModelSnapshot(model, model.provider));
    }
  }

  async preflight(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    return this.create(providerId, modelId);
  }

  async create(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    if (this.registeredProviderIds.has(providerId)) {
      throw new ProviderReadinessError(
        providerId,
        "registered-provider-policy-unavailable",
        `Provider ${providerId} is extension-registered. Pi 0.81.1 exposes neither a registration/auth-refresh readiness receipt nor a self-contained hook policy for isolated workers; no email was accepted.`,
      );
    }

    let runtime: ModelRuntime;
    try {
      runtime = await this.createRuntime(this.options);
    } catch {
      throw new ProviderReadinessError(
        providerId,
        "runtime-snapshot-unavailable",
        `Worker runtime snapshot for provider ${providerId} could not be created. Correct provider/model configuration, then reload the extension.`,
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

    const parentRequest = this.requestModels.get(modelKey(providerId, modelId));
    if (!parentRequest) {
      throw new ProviderReadinessError(
        providerId,
        "model-snapshot-missing",
        `Model ${providerId}/${modelId} was not present in the extension-start model snapshot. Reload the extension.`,
      );
    }
    const workerRequest = requestModelSnapshot(model, providerId);
    if (!isDeepStrictEqual(parentRequest, workerRequest)) {
      throw new ProviderReadinessError(
        providerId,
        "model-request-metadata-mismatch",
        `Model ${providerId}/${modelId} request metadata differs from the extension-start snapshot. API, endpoint, reasoning/thinking, input, cost, context/output limits, or compatibility policy changed; reload the extension.`,
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
