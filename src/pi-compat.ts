import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import * as TypeBox from "typebox";

export const SUPPORTED_PI_VERSION = "0.84.2";

export interface CollectedReplyPresentationCapability {
  supported: false;
  reason: string;
  requiredCoreContract: string;
}

export interface UnavailablePiCoreCapability {
  supported: false;
  detailCode: string;
  reason: string;
  requiredCoreContract: string;
}

/**
 * Pi 0.84.2 has no released staged tool-result append receipt. Keep collection
 * policy fail-closed instead of inferring presentation from execute() return,
 * tool lifecycle events, stdout, sendMessage(), or appendEntry().
 */
export function collectedReplyPresentationCapability(): CollectedReplyPresentationCapability {
  return {
    supported: false,
    reason: `Pi ${SUPPORTED_PI_VERSION} custom tool execution exposes no post-append acknowledgement for its exact tool-result session entry.`,
    requiredCoreContract: "A stable request/reply/toolCall/result-entry staged receipt whose post-append commit callback settles before Pi continues the agent.",
  };
}

/** General presentation boundary shared by main delivery and worker prompt/steer/follow-up. */
export function sessionPresentationReceiptCapability(): UnavailablePiCoreCapability {
  return {
    supported: false,
    detailCode: "PI_SESSION_PRESENTATION_RECEIPT_UNAVAILABLE",
    reason: `Pi ${SUPPORTED_PI_VERSION} sendMessage, prompt preflight, steer, and followUp do not acknowledge a durable native-session append.`,
    requiredCoreContract: "A stable envelope/session-entry receipt with a post-append commit acknowledgement recoverable by envelope ID after every crash kill point.",
  };
}

/**
 * Pi's public mutation queue is useful only for its documented per-key scope.
 * The extension has no supported interception point from which to strengthen
 * that identity across every built-in/custom mutation session.
 */
export function directMutationAliasSerializationCapability(): UnavailablePiCoreCapability {
  return {
    supported: false,
    detailCode: "PI_MUTATION_ALIAS_IDENTITY_UNAVAILABLE",
    reason: `Pi ${SUPPORTED_PI_VERSION} cannot assign one authoritative queue key to every missing target alias or existing hard-link alias.`,
    requiredCoreContract: "A supported alias identity covering missing-target symlink ancestors, existing hard-link aliases, replacement/rename windows, and concurrent create windows.",
  };
}

interface Feature {
  path: string;
  present: (surface: unknown) => boolean;
}

const MAX_REPORTED_MISSING_FEATURES = 32;

/** Property access is guarded so a malformed optional constructor/prototype cannot mask the compatibility diagnostic. */
function member(surface: unknown, path: readonly string[]): unknown {
  let current = surface;
  try {
    for (const part of path) {
      if ((typeof current !== "object" || current === null) && typeof current !== "function") return undefined;
      current = Reflect.get(current, part);
    }
    return current;
  } catch {
    return undefined;
  }
}

function callablePath(...path: string[]): Feature["present"] {
  return (surface) => typeof member(surface, path) === "function";
}

function objectPath(...path: string[]): Feature["present"] {
  return (surface) => {
    const value = member(surface, path);
    return typeof value === "object" && value !== null;
  };
}

function valuePath(type: "string" | "number", ...path: string[]): Feature["present"] {
  return (surface) => typeof member(surface, path) === type;
}

const CODING_AGENT_FEATURES: Feature[] = [
  { path: "getAgentDir", present: callablePath("getAgentDir") },
  { path: "defineTool", present: callablePath("defineTool") },
  { path: "createAgentSession", present: callablePath("createAgentSession") },
  { path: "renderDiff", present: callablePath("renderDiff") },
  { path: "truncateHead", present: callablePath("truncateHead") },
  { path: "formatSize", present: callablePath("formatSize") },
  { path: "SessionManager.open", present: callablePath("SessionManager", "open") },
  { path: "SessionManager.create", present: callablePath("SessionManager", "create") },
  { path: "SessionManager.prototype.getBranch", present: callablePath("SessionManager", "prototype", "getBranch") },
  { path: "SessionManager.prototype.getSessionId", present: callablePath("SessionManager", "prototype", "getSessionId") },
  { path: "SessionManager.prototype.appendCustomEntry", present: callablePath("SessionManager", "prototype", "appendCustomEntry") },
  { path: "ModelRuntime.create", present: callablePath("ModelRuntime", "create") },
  { path: "ModelRuntime.prototype.getModel", present: callablePath("ModelRuntime", "prototype", "getModel") },
  { path: "ModelRuntime.prototype.getAvailable", present: callablePath("ModelRuntime", "prototype", "getAvailable") },
  { path: "ModelRuntime.prototype.getProviderAuthStatus", present: callablePath("ModelRuntime", "prototype", "getProviderAuthStatus") },
  { path: "ModelRuntime.prototype.registerNativeProvider", present: callablePath("ModelRuntime", "prototype", "registerNativeProvider") },
  { path: "ModelRuntime.prototype.registerProvider", present: callablePath("ModelRuntime", "prototype", "registerProvider") },
  { path: "ModelRegistry.prototype.getRegisteredProviderIds", present: callablePath("ModelRegistry", "prototype", "getRegisteredProviderIds") },
  { path: "ModelRegistry.prototype.getRegisteredNativeProvider", present: callablePath("ModelRegistry", "prototype", "getRegisteredNativeProvider") },
  { path: "ModelRegistry.prototype.getRegisteredProviderConfig", present: callablePath("ModelRegistry", "prototype", "getRegisteredProviderConfig") },
  { path: "ModelRegistry.prototype.getProviderAuthStatus", present: callablePath("ModelRegistry", "prototype", "getProviderAuthStatus") },
  { path: "ModelRegistry.prototype.getAvailable", present: callablePath("ModelRegistry", "prototype", "getAvailable") },
  { path: "ModelRegistry.prototype.getAll", present: callablePath("ModelRegistry", "prototype", "getAll") },
  { path: "SettingsManager.create", present: callablePath("SettingsManager", "create") },
  { path: "SettingsManager.fromStorage", present: callablePath("SettingsManager", "fromStorage") },
  { path: "SettingsManager.inMemory", present: callablePath("SettingsManager", "inMemory") },
  { path: "SettingsManager.prototype.getGlobalSettings", present: callablePath("SettingsManager", "prototype", "getGlobalSettings") },
  { path: "SettingsManager.prototype.getProjectSettings", present: callablePath("SettingsManager", "prototype", "getProjectSettings") },
  { path: "SettingsManager.prototype.drainErrors", present: callablePath("SettingsManager", "prototype", "drainErrors") },
  { path: "SettingsManager.prototype.applyOverrides", present: callablePath("SettingsManager", "prototype", "applyOverrides") },
  { path: "AgentSession.prototype.subscribe", present: callablePath("AgentSession", "prototype", "subscribe") },
  { path: "AgentSession.prototype.dispose", present: callablePath("AgentSession", "prototype", "dispose") },
  { path: "AgentSession.prototype.getActiveToolNames", present: callablePath("AgentSession", "prototype", "getActiveToolNames") },
  { path: "AgentSession.prototype.prompt", present: callablePath("AgentSession", "prototype", "prompt") },
  { path: "AgentSession.prototype.steer", present: callablePath("AgentSession", "prototype", "steer") },
  { path: "AgentSession.prototype.followUp", present: callablePath("AgentSession", "prototype", "followUp") },
  { path: "AgentSession.prototype.abort", present: callablePath("AgentSession", "prototype", "abort") },
  { path: "AgentSession.prototype.setThinkingLevel", present: callablePath("AgentSession", "prototype", "setThinkingLevel") },
  { path: "AgentSession.prototype.setSteeringMode", present: callablePath("AgentSession", "prototype", "setSteeringMode") },
  { path: "AgentSession.prototype.setFollowUpMode", present: callablePath("AgentSession", "prototype", "setFollowUpMode") },
  { path: "DefaultResourceLoader", present: callablePath("DefaultResourceLoader") },
  { path: "DefaultResourceLoader.prototype.reload", present: callablePath("DefaultResourceLoader", "prototype", "reload") },
  { path: "CONFIG_DIR_NAME", present: valuePath("string", "CONFIG_DIR_NAME") },
  { path: "DEFAULT_MAX_BYTES", present: valuePath("number", "DEFAULT_MAX_BYTES") },
  { path: "DEFAULT_MAX_LINES", present: valuePath("number", "DEFAULT_MAX_LINES") },
];

const AI_FEATURES: Feature[] = [
  { path: "StringEnum", present: callablePath("StringEnum") },
];

const TUI_FEATURES: Feature[] = [
  { path: "Box", present: callablePath("Box") },
  { path: "Key", present: objectPath("Key") },
  { path: "Text", present: callablePath("Text") },
  { path: "matchesKey", present: callablePath("matchesKey") },
  { path: "truncateToWidth", present: callablePath("truncateToWidth") },
  { path: "wrapTextWithAnsi", present: callablePath("wrapTextWithAnsi") },
];

const TYPEBOX_FEATURES: Feature[] = [
  { path: "Type", present: objectPath("Type") },
];

const EXTENSION_API_FEATURES: Feature[] = [
  { path: "registerTool", present: callablePath("registerTool") },
  { path: "registerMessageRenderer", present: callablePath("registerMessageRenderer") },
  { path: "registerCommand", present: callablePath("registerCommand") },
  { path: "registerShortcut", present: callablePath("registerShortcut") },
  { path: "sendMessage", present: callablePath("sendMessage") },
  { path: "getThinkingLevel", present: callablePath("getThinkingLevel") },
  { path: "on", present: callablePath("on") },
];

function unsupportedRuntimeError(missing: readonly string[]): Error {
  const shown = missing.slice(0, MAX_REPORTED_MISSING_FEATURES);
  const omitted = missing.length - shown.length;
  const omission = omitted > 0 ? `, ... (${omitted} additional required feature(s) omitted)` : "";
  return new Error(
    `pi-email-subagent requires the Pi ${SUPPORTED_PI_VERSION} public API surface; missing required feature(s): ${shown.join(", ")}${omission}. `
    + `Install Pi ${SUPPORTED_PI_VERSION} or use an extension release explicitly tested for your Pi version. Structural probes improve failure diagnostics but do not certify behavioral compatibility.`,
  );
}

export function assertPiRuntimeFeatures(
  codingAgent: Record<string, unknown>,
  ai: Record<string, unknown>,
  tui: Record<string, unknown>,
  typebox: Record<string, unknown>,
): void {
  const actualVersion = member(codingAgent, ["VERSION"]);
  if (actualVersion !== SUPPORTED_PI_VERSION) {
    const actual = typeof actualVersion === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(actualVersion)
      ? actualVersion
      : "missing or invalid";
    throw new Error(
      `pi-email-subagent requires an exact tested Pi version; actual ${actual}; supported ${SUPPORTED_PI_VERSION}. `
      + `Install Pi ${SUPPORTED_PI_VERSION} or use an extension release explicitly tested for your Pi version. Structural similarity does not certify behavioral compatibility.`,
    );
  }
  const missing = [
    ...CODING_AGENT_FEATURES.filter((feature) => !feature.present(codingAgent)).map((feature) => `@earendil-works/pi-coding-agent.${feature.path}`),
    ...AI_FEATURES.filter((feature) => !feature.present(ai)).map((feature) => `@earendil-works/pi-ai.${feature.path}`),
    ...TUI_FEATURES.filter((feature) => !feature.present(tui)).map((feature) => `@earendil-works/pi-tui.${feature.path}`),
    ...TYPEBOX_FEATURES.filter((feature) => !feature.present(typebox)).map((feature) => `typebox.${feature.path}`),
  ];
  if (missing.length > 0) throw unsupportedRuntimeError(missing);
}

/** Verify the actual host facade before any registration or broker/state construction. */
export function assertExtensionApiFeatures(pi: unknown): void {
  const missing = EXTENSION_API_FEATURES
    .filter((feature) => !feature.present(pi))
    .map((feature) => `ExtensionAPI.${feature.path}`);
  if (missing.length > 0) throw unsupportedRuntimeError(missing);
}

export function assertSupportedPiRuntime(): void {
  assertPiRuntimeFeatures(
    PiCodingAgent as unknown as Record<string, unknown>,
    PiAi as unknown as Record<string, unknown>,
    PiTui as unknown as Record<string, unknown>,
    TypeBox as unknown as Record<string, unknown>,
  );
}
