import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

export const SUPPORTED_PI_VERSION = "0.84.2";

interface Feature {
  path: string;
  present: (surface: unknown) => boolean;
}

const EXTENSION_API_FEATURES: Feature[] = [
  { path: "registerTool", present: (surface) => callable(surface, "registerTool") },
  { path: "registerMessageRenderer", present: (surface) => callable(surface, "registerMessageRenderer") },
  { path: "registerCommand", present: (surface) => callable(surface, "registerCommand") },
  { path: "registerShortcut", present: (surface) => callable(surface, "registerShortcut") },
  { path: "sendMessage", present: (surface) => callable(surface, "sendMessage") },
  { path: "getThinkingLevel", present: (surface) => callable(surface, "getThinkingLevel") },
  { path: "on", present: (surface) => callable(surface, "on") },
  { path: "events.emit", present: (surface) => callable(member(surface, "events"), "emit") },
];

function member(surface: unknown, key: string): unknown {
  try {
    if ((typeof surface !== "object" || surface === null) && typeof surface !== "function") return undefined;
    return Reflect.get(surface, key);
  } catch {
    return undefined;
  }
}

function callable(surface: unknown, key: string): boolean {
  return typeof member(surface, key) === "function";
}

function supportedVersionError(actual: unknown): Error {
  const shown = typeof actual === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(actual)
    ? actual
    : "missing or invalid";
  return new Error(
    `pi-email-subagent requires exact Pi ${SUPPORTED_PI_VERSION}; actual ${shown}. `
    + `Install Pi ${SUPPORTED_PI_VERSION} or use an extension release tested for your Pi version.`,
  );
}

function extensionSurfaceError(missing: readonly string[]): Error {
  return new Error(
    `pi-email-subagent requires the Pi ${SUPPORTED_PI_VERSION} ExtensionAPI surface; missing: ${missing.join(", ")}. `
    + `Install Pi ${SUPPORTED_PI_VERSION} or use an extension release tested for your Pi version.`,
  );
}

/** Exact supported-version gate. Internal host exports are not duplicated as speculative descriptors. */
export function assertPiVersion(codingAgent: Record<string, unknown>): void {
  if (member(codingAgent, "VERSION") !== SUPPORTED_PI_VERSION) {
    throw supportedVersionError(member(codingAgent, "VERSION"));
  }
}

/** Verify only the public ExtensionAPI facade supplied to this extension. */
export function assertExtensionApiFeatures(pi: unknown): void {
  const missing = EXTENSION_API_FEATURES
    .filter((feature) => !feature.present(pi))
    .map((feature) => `ExtensionAPI.${feature.path}`);
  if (missing.length > 0) throw extensionSurfaceError(missing);
}

export function assertSupportedPiRuntime(): void {
  assertPiVersion(PiCodingAgent as unknown as Record<string, unknown>);
}
