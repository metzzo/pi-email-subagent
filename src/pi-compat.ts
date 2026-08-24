import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import * as TypeBox from "typebox";

export const SUPPORTED_PI_VERSION = "0.81.1";

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
 * Pi 0.81.1 has no released staged tool-result append receipt. Keep collection
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

/**
 * No released Pi API can prove process-tree absence for one exact worker
 * generation. This gate stays false even if an untested host happens to expose
 * a similarly named method; integration requires a deliberate version upgrade.
 */
export function processQuiescenceReceiptCapability(): UnavailablePiCoreCapability {
  return {
    supported: false,
    detailCode: "PI_0_81_1_PROCESS_QUIESCENCE_RECEIPT_UNAVAILABLE",
    reason: `Pi ${SUPPORTED_PI_VERSION} exposes no authoritative session/generation-scoped process-tree cleanup receipt.`,
    requiredCoreContract: "An idempotent exact session/generation receipt covering provider quiescence, settled callbacks, active tool receipts, completed process group/tree receipts, platform/source detail, and verified-or-unknown confidence.",
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
    detailCode: "PI_0_81_1_MUTATION_ALIAS_IDENTITY_UNAVAILABLE",
    reason: `Pi ${SUPPORTED_PI_VERSION} cannot assign one authoritative queue key to every missing target alias or existing hard-link alias.`,
    requiredCoreContract: "A supported alias identity covering missing-target symlink ancestors, existing hard-link aliases, replacement/rename windows, and concurrent create windows.",
  };
}

interface Feature {
  path: string;
  present: (module: Record<string, unknown>) => boolean;
}

function callable(value: unknown): boolean {
  return typeof value === "function";
}

const CODING_AGENT_FEATURES: Feature[] = [
  { path: "getAgentDir", present: (module) => callable(module.getAgentDir) },
  { path: "defineTool", present: (module) => callable(module.defineTool) },
  { path: "createAgentSession", present: (module) => callable(module.createAgentSession) },
  { path: "renderDiff", present: (module) => callable(module.renderDiff) },
  { path: "truncateHead", present: (module) => callable(module.truncateHead) },
  { path: "formatSize", present: (module) => callable(module.formatSize) },
  { path: "SessionManager.open", present: (module) => callable((module.SessionManager as { open?: unknown } | undefined)?.open) },
  { path: "SessionManager.create", present: (module) => callable((module.SessionManager as { create?: unknown } | undefined)?.create) },
  { path: "ModelRuntime.create", present: (module) => callable((module.ModelRuntime as { create?: unknown } | undefined)?.create) },
  { path: "ModelRuntime.prototype.getProviderAuthStatus", present: (module) => callable((module.ModelRuntime as { prototype?: { getProviderAuthStatus?: unknown } } | undefined)?.prototype?.getProviderAuthStatus) },
  { path: "ModelRegistry.prototype.getProviderAuthStatus", present: (module) => callable((module.ModelRegistry as { prototype?: { getProviderAuthStatus?: unknown } } | undefined)?.prototype?.getProviderAuthStatus) },
  { path: "SettingsManager.create", present: (module) => callable((module.SettingsManager as { create?: unknown } | undefined)?.create) },
  { path: "SettingsManager.fromStorage", present: (module) => callable((module.SettingsManager as { fromStorage?: unknown } | undefined)?.fromStorage) },
  { path: "SettingsManager.prototype.getGlobalSettings", present: (module) => callable((module.SettingsManager as { prototype?: { getGlobalSettings?: unknown } } | undefined)?.prototype?.getGlobalSettings) },
  { path: "SettingsManager.prototype.getProjectSettings", present: (module) => callable((module.SettingsManager as { prototype?: { getProjectSettings?: unknown } } | undefined)?.prototype?.getProjectSettings) },
  { path: "DefaultResourceLoader", present: (module) => callable(module.DefaultResourceLoader) },
  { path: "CONFIG_DIR_NAME", present: (module) => typeof module.CONFIG_DIR_NAME === "string" },
  { path: "DEFAULT_MAX_BYTES", present: (module) => typeof module.DEFAULT_MAX_BYTES === "number" },
  { path: "DEFAULT_MAX_LINES", present: (module) => typeof module.DEFAULT_MAX_LINES === "number" },
];

const AI_FEATURES: Feature[] = [
  { path: "StringEnum", present: (module) => callable(module.StringEnum) },
];

const TUI_FEATURES: Feature[] = [
  { path: "Box", present: (module) => callable(module.Box) },
  { path: "Key", present: (module) => typeof module.Key === "object" && module.Key !== null },
  { path: "Text", present: (module) => callable(module.Text) },
  { path: "matchesKey", present: (module) => callable(module.matchesKey) },
  { path: "truncateToWidth", present: (module) => callable(module.truncateToWidth) },
  { path: "wrapTextWithAnsi", present: (module) => callable(module.wrapTextWithAnsi) },
];

const TYPEBOX_FEATURES: Feature[] = [
  { path: "Type", present: (module) => typeof module.Type === "object" && module.Type !== null },
];

export function assertPiRuntimeFeatures(
  codingAgent: Record<string, unknown>,
  ai: Record<string, unknown>,
  tui: Record<string, unknown>,
  typebox: Record<string, unknown>,
): void {
  const missing = [
    ...CODING_AGENT_FEATURES.filter((feature) => !feature.present(codingAgent)).map((feature) => `@earendil-works/pi-coding-agent.${feature.path}`),
    ...AI_FEATURES.filter((feature) => !feature.present(ai)).map((feature) => `@earendil-works/pi-ai.${feature.path}`),
    ...TUI_FEATURES.filter((feature) => !feature.present(tui)).map((feature) => `@earendil-works/pi-tui.${feature.path}`),
    ...TYPEBOX_FEATURES.filter((feature) => !feature.present(typebox)).map((feature) => `typebox.${feature.path}`),
  ];
  if (missing.length > 0) {
    throw new Error(
      `pi-email-subagent requires the Pi ${SUPPORTED_PI_VERSION} public API surface; missing required feature(s): ${missing.join(", ")}. `
      + `Install Pi ${SUPPORTED_PI_VERSION} or use an extension release explicitly tested for your Pi version.`,
    );
  }
}

export function assertSupportedPiRuntime(): void {
  assertPiRuntimeFeatures(
    PiCodingAgent as unknown as Record<string, unknown>,
    PiAi as unknown as Record<string, unknown>,
    PiTui as unknown as Record<string, unknown>,
    TypeBox as unknown as Record<string, unknown>,
  );
}
