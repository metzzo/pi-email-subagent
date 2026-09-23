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

function extensionSurfaceError(missing: readonly string[]): Error {
  return new Error(
    `pi-email-subagent requires the public Pi ExtensionAPI surface; missing: ${missing.join(", ")}. `
    + "Update Pi to a version providing these APIs.",
  );
}

/** Verify only the public ExtensionAPI facade supplied to this extension. */
export function assertExtensionApiFeatures(pi: unknown): void {
  const missing = EXTENSION_API_FEATURES
    .filter((feature) => !feature.present(pi))
    .map((feature) => `ExtensionAPI.${feature.path}`);
  if (missing.length > 0) throw extensionSurfaceError(missing);
}
