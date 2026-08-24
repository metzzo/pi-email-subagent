import { createProvider, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const UNSAFE_NATIVE_PROVIDER_ID = "unsafe-native-fixture";
export const UNSAFE_NATIVE_MODEL_ID = "unsafe-native-model";
export const UNSAFE_NATIVE_HEADER_SENTINEL = "SENTINEL_NATIVE_PROVIDER_HEADER_VALUE";

const model: Model<"unsafe-native-fixture-api"> = {
  id: UNSAFE_NATIVE_MODEL_ID,
  name: "Unsafe native provider fixture",
  api: "unsafe-native-fixture-api",
  provider: UNSAFE_NATIVE_PROVIDER_ID,
  baseUrl: "http://127.0.0.1:9/unsafe-native-fixture",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
};

const unreachableStreams = {
  stream() { throw new Error("unsafe native fixture stream must never execute"); },
  streamSimple() { throw new Error("unsafe native fixture stream must never execute"); },
} as unknown as ProviderStreams;

export default function unsafeNativeProvider(pi: ExtensionAPI): void {
  pi.registerProvider(createProvider({
    id: UNSAFE_NATIVE_PROVIDER_ID,
    name: "Unsafe native provider fixture",
    baseUrl: model.baseUrl,
    headers: { "x-native-fixture": UNSAFE_NATIVE_HEADER_SENTINEL },
    auth: {
      apiKey: {
        name: "Unsafe native fixture",
        check: async () => ({ type: "api_key", source: "fixture" }),
        resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }),
      },
    },
    models: [model],
    api: unreachableStreams,
  }));
}
