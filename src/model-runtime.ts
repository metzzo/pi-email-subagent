import type { Api, Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { CreateModelRuntimeOptions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Copy extension-registered providers from the parent Pi session into the
 * isolated runtime used by SDK workers. Model objects alone are insufficient:
 * custom providers can also supply request protocols, OAuth hooks, and stream
 * implementations that a newly-created ModelRuntime does not know about.
 */
export function inheritRegisteredProviders(source: ModelRegistry, target: ModelRuntime): void {
  for (const providerId of source.getRegisteredProviderIds()) {
    const nativeProvider = source.getRegisteredNativeProvider(providerId);
    if (nativeProvider) {
      target.registerNativeProvider(nativeProvider);
      continue;
    }

    const config = source.getRegisteredProviderConfig(providerId);
    if (config) target.registerProvider(providerId, config);
  }
}

export interface WorkerRuntimeSnapshot {
  runtime: ModelRuntime;
  model: Model<Api>;
}

type RuntimeCreator = (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
type AuthStatus = ReturnType<ModelRegistry["getProviderAuthStatus"]>;

type ProviderSnapshot =
  | { kind: "native"; provider: NonNullable<ReturnType<ModelRegistry["getRegisteredNativeProvider"]>> }
  | { kind: "configured"; id: string; config: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>> };

interface ModelCompatibilitySnapshot {
  api: Api;
  supportsLongCacheRetention: boolean;
}

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

function compatibilitySnapshot(model: Model<Api>): ModelCompatibilitySnapshot {
  return {
    api: model.api,
    // Pi's relevant provider adapters default this compatibility capability to
    // true. An endpoint that rejects long retention must publish false.
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * Creates one immutable-at-extension-start provider/model/auth-status snapshot
 * for workers. The same explicit auth and models paths used by main must be
 * supplied; later provider definition, metadata, or source-class changes
 * intentionally require an extension reload.
 */
export class WorkerRuntimeFactory {
  private readonly providers: ProviderSnapshot[];
  private readonly parentAuth = new Map<string, AuthStatus>();
  private readonly modelCompatibility = new Map<string, ModelCompatibilitySnapshot>();

  constructor(
    private readonly source: ModelRegistry,
    private readonly options: CreateModelRuntimeOptions,
    private readonly createRuntime: RuntimeCreator = PiCodingAgent.ModelRuntime.create,
  ) {
    this.providers = source.getRegisteredProviderIds().flatMap((id): ProviderSnapshot[] => {
      const nativeProvider = source.getRegisteredNativeProvider(id);
      if (nativeProvider) return [{ kind: "native", provider: nativeProvider }];
      const config = source.getRegisteredProviderConfig(id);
      return config ? [{ kind: "configured", id, config }] : [];
    });
    for (const model of source.getAll()) {
      if (!this.parentAuth.has(model.provider)) {
        this.parentAuth.set(model.provider, { ...source.getProviderAuthStatus(model.provider) });
      }
      this.modelCompatibility.set(modelKey(model.provider, model.id), compatibilitySnapshot(model));
    }
  }

  async preflight(providerId: string, modelId: string): Promise<void> {
    await this.create(providerId, modelId);
  }

  async create(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    let runtime: ModelRuntime;
    try {
      runtime = await this.createRuntime(this.options);
      for (const provider of this.providers) {
        if (provider.kind === "native") runtime.registerNativeProvider(provider.provider);
        else runtime.registerProvider(provider.id, provider.config);
      }
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

    const parentCompatibility = this.modelCompatibility.get(modelKey(providerId, modelId));
    if (!parentCompatibility) {
      throw new ProviderReadinessError(
        providerId,
        "model-snapshot-missing",
        `Model ${providerId}/${modelId} was not present in the extension-start model snapshot. Reload the extension.`,
      );
    }
    const workerCompatibility = compatibilitySnapshot(model);
    if (parentCompatibility.api !== workerCompatibility.api
      || parentCompatibility.supportsLongCacheRetention !== workerCompatibility.supportsLongCacheRetention) {
      throw new ProviderReadinessError(
        providerId,
        "model-compatibility-mismatch",
        `Model ${providerId}/${modelId} compatibility metadata for API family or long cache retention differs from the extension-start snapshot. Reload the extension after correcting model metadata.`,
      );
    }

    const parentStatus = this.parentAuth.get(providerId) ?? { configured: false };
    const workerStatus = runtime.getProviderAuthStatus(providerId);
    assertCredentialSourceEquivalent(providerId, parentStatus, workerStatus);

    return { runtime, model };
  }
}
