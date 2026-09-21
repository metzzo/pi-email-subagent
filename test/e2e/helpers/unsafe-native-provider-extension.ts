import {
  createProvider,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, writeFile } from "node:fs/promises";

export const UNSAFE_NATIVE_PROVIDER_ID = "unsafe-native-fixture";
export const UNSAFE_NATIVE_MODEL_ID = "unsafe-native-model";
export const UNSAFE_NATIVE_HEADER_SENTINEL =
  "SENTINEL_NATIVE_PROVIDER_HEADER_VALUE";

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
  ...(process.env.PI_EMAIL_NATIVE_MODEL_HEADERS === "1"
    ? { headers: { "x-native-model": UNSAFE_NATIVE_HEADER_SENTINEL } }
    : {}),
};

const unreachableStreams = {
  stream() {
    throw new Error("unsafe native fixture stream must never execute");
  },
  streamSimple() {
    throw new Error("unsafe native fixture stream must never execute");
  },
} as unknown as ProviderStreams;

export default function unsafeNativeProvider(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, context) => {
    await (
      context as unknown as {
        modelRegistry: { refresh: (options: unknown) => Promise<unknown> };
      }
    ).modelRegistry.refresh({
      providers: [UNSAFE_NATIVE_PROVIDER_ID],
      allowNetwork: true,
      force: true,
    });
  });
  pi.registerProvider(
    createProvider({
      id: UNSAFE_NATIVE_PROVIDER_ID,
      name: "Unsafe native provider fixture",
      baseUrl: model.baseUrl,
      headers: { "x-native-fixture": UNSAFE_NATIVE_HEADER_SENTINEL },
      auth: {
        apiKey: {
          name: "Unsafe native fixture",
          check: async () => ({ type: "api_key", source: "fixture" }),
          resolve: async () => ({
            auth: { apiKey: "fixture" },
            source: "fixture",
          }),
        },
      },
      models: process.env.PI_NATIVE_FIXTURE_GATE ? [] : [model],
      ...(process.env.PI_NATIVE_FIXTURE_GATE
        ? {
            fetchModels: async (context: { signal: AbortSignal }) => {
              const gate = process.env.PI_NATIVE_FIXTURE_GATE;
              if (!gate) return [];
              if (process.env.PI_NATIVE_FIXTURE_FETCH_STARTED)
                await writeFile(
                  process.env.PI_NATIVE_FIXTURE_FETCH_STARTED,
                  "started",
                );
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline) {
                try {
                  await access(gate);
                  return [model];
                } catch {
                  if (context.signal.aborted) return [];
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
              }
              return [];
            },
          }
        : {}),
      api: unreachableStreams,
    }),
  );
}
