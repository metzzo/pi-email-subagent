import type { AgentRecord } from "./types.ts";
import { clone, nowIso, truncateText } from "./util.ts";

export interface AbandonedOwnerRecoveryTransition {
  record: AgentRecord;
  changed: boolean;
}

function appendWarning(record: AgentRecord, warning: string, at: string): void {
  record.failure = truncateText(warning, 1_500);
  record.currentActivity = record.failure;
  record.activity.push({ at, kind: "status", summary: record.failure });
  record.activity = record.activity.slice(-40);
  record.updatedAt = at;
}

/**
 * Normalizes durable state only after NamespaceLock proved the exact prior
 * Linux owner identity dead. That proof ends ownership of its in-process Pi
 * AgentSessions and callbacks; it says nothing about deliberately detached OS
 * effects from commands that had already completed.
 */
export function transitionAbandonedOwnerRecovery(
  source: AgentRecord,
  at = nowIso(),
): AbandonedOwnerRecoveryTransition {
  const record = clone(source);
  const epoch = record.workerEpoch;
  const cleanup = record.cleanup;
  const exactCleanupGeneration = Boolean(
    cleanup
    && epoch
    && cleanup.workerGeneration === epoch.generation
    && (epoch.phase === "spawning" || epoch.phase === "activated"),
  );

  if (cleanup && !exactCleanupGeneration) {
    // An incoherent generation cannot be normalized from process identity
    // alone. Keep an exact-address diagnostic, but never retain a dead owner's
    // run-slot claim or create a namespace-wide scheduling block.
    record.cleanup = {
      ...cleanup,
      state: "unknown",
      updatedAt: at,
      heldRunSlot: false,
      detail: truncateText(
        `Exact prior broker owner is dead, but cleanup generation ${cleanup.workerGeneration} does not match the durable worker epoch ${epoch?.generation ?? "missing"}; exact-address restart remains blocked.`,
        1_500,
      ),
    };
    record.state = "failed";
    appendWarning(
      record,
      `Cleanup state for generation ${cleanup.workerGeneration} is structurally ambiguous after exact-owner death; only this address remains blocked.`,
      at,
    );
    return { record, changed: true };
  }

  if (cleanup) {
    const completedLegacyShape = cleanup.abort === "succeeded"
      && cleanup.dispose === "succeeded"
      && cleanup.activeTools.length === 0
      && !cleanup.heldRunSlot;
    delete record.cleanup;
    record.workerEpoch = { ...epoch!, phase: "session-settled", runSlotHeld: false };
    record.state = "failed";
    appendWarning(
      record,
      completedLegacyShape
        ? `Historical cleanup generation ${cleanup.workerGeneration} was migrated to Pi session/tool settled after exact-owner death; no OS-process proof is claimed. Explicit same-identity restart is required.`
        : `The exact prior broker owner died, so generation ${cleanup.workerGeneration}'s in-process Pi session and callbacks are gone; no OS-process proof is claimed. Explicit same-identity restart is required.`,
      at,
    );
    return { record, changed: true };
  }

  const priorSessionCouldExist = !epoch
    ? !["stopped", "archived"].includes(record.state)
    : epoch.phase === "spawning" || epoch.phase === "activated";
  if (!priorSessionCouldExist) return { record, changed: false };

  if (epoch) record.workerEpoch = { ...epoch, phase: "session-settled", runSlotHeld: false };
  record.state = "failed";
  appendWarning(
    record,
    "The exact prior broker owner died; its in-process Pi session and callbacks are gone. Explicit same-identity restart is required. No OS-process proof is claimed.",
    at,
  );
  return { record, changed: true };
}
