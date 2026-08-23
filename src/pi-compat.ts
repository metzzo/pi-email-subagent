import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";

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
  { path: "SettingsManager.create", present: (module) => callable((module.SettingsManager as { create?: unknown } | undefined)?.create) },
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

export function assertPiRuntimeFeatures(
  codingAgent: Record<string, unknown>,
  ai: Record<string, unknown>,
  tui: Record<string, unknown>,
): void {
  const missing = [
    ...CODING_AGENT_FEATURES.filter((feature) => !feature.present(codingAgent)).map((feature) => `@earendil-works/pi-coding-agent.${feature.path}`),
    ...AI_FEATURES.filter((feature) => !feature.present(ai)).map((feature) => `@earendil-works/pi-ai.${feature.path}`),
    ...TUI_FEATURES.filter((feature) => !feature.present(tui)).map((feature) => `@earendil-works/pi-tui.${feature.path}`),
  ];
  if (missing.length > 0) {
    throw new Error(
      `pi-email-subagent requires the Pi 0.81.1 public API surface; missing required feature(s): ${missing.join(", ")}. `
      + "Install Pi 0.81.1 or use an extension release explicitly tested for your Pi version.",
    );
  }
}

export function assertSupportedPiRuntime(): void {
  assertPiRuntimeFeatures(
    PiCodingAgent as unknown as Record<string, unknown>,
    PiAi as unknown as Record<string, unknown>,
    PiTui as unknown as Record<string, unknown>,
  );
}
