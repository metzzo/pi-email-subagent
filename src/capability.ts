const KNOWN_NON_MUTATING_TOOLS = new Set(["read", "grep", "find", "ls", "send_email", "fetch_emails"]);

/** User-facing configured/live writability. Unknown custom tools fail closed as writable. */
export function isConfiguredWritable(tools: readonly string[]): boolean {
  return tools.some((tool) => !KNOWN_NON_MUTATING_TOOLS.has(tool));
}

/** Cleanup/takeover classifier. Unknown and legacy custom tools are effect-capable. */
export function isConservativeCleanupCapable(tools: readonly string[]): boolean {
  return tools.some((tool) => !KNOWN_NON_MUTATING_TOOLS.has(tool));
}
