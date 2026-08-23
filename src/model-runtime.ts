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

type ProviderSnapshot =
  | { kind: "native"; provider: NonNullable<ReturnType<ModelRegistry["getRegisteredNativeProvider"]>> }
  | { kind: "configured"; id: string; config: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>> };

/**
 * Creates one immutable-at-extension-start provider snapshot for workers. The
 * same auth and models paths used by main must be supplied; later provider
 * definition changes intentionally require an extension reload.
 */
export class WorkerRuntimeFactory {
  private readonly providers: ProviderSnapshot[];

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
  }

  async create(providerId: string, modelId: string): Promise<WorkerRuntimeSnapshot> {
    const runtime = await this.createRuntime(this.options);
    for (const provider of this.providers) {
      if (provider.kind === "native") runtime.registerNativeProvider(provider.provider);
      else runtime.registerProvider(provider.id, provider.config);
    }

    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      throw new Error(
        `Model ${providerId}/${modelId} is not available in the worker runtime snapshot. `
        + "Reload the extension after changing provider or model configuration.",
      );
    }

    const parentAuth = await this.source.getProviderAuth(providerId);
    const workerAuth = await runtime.getAuth(model);
    if (parentAuth && !workerAuth) {
      throw new Error(
        `Authentication for provider ${providerId} is available only in the parent runtime and cannot be transferred `
        + "to an isolated worker. Persist the credential in Pi's auth store, then reload the extension.",
      );
    }

    return { runtime, model };
  }
}
