import type { AgentStatus, LifecyclePolicy } from "./types.ts";
import { lifecycleDuration } from "./runtime-timers.ts";

export function workerCleanupDeadline(lifecycle: Pick<LifecyclePolicy, "abortTimeoutMs" | "disposeTimeoutMs">): number {
  return lifecycleDuration(lifecycle.abortTimeoutMs, lifecycle.disposeTimeoutMs);
}

export function isInactiveWorkerState(state: AgentStatus): boolean {
  return state === "failed" || state === "stopped" || state === "paused" || state === "archived";
}
