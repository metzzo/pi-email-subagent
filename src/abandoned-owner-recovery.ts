import { isConservativeCleanupCapable } from "./capability.ts";
import type { AgentRecord } from "./types.ts";
import { clone, nowIso, truncateText } from "./util.ts";

export interface AbandonedOwnerRecoveryTransition {
  record: AgentRecord;
  changed: boolean;
}

function structurallyExactOperatorRelease(record: AgentRecord): boolean {
  const epoch = record.workerEpoch;
  return epoch?.phase === "operator-released"
    && !record.cleanup
    && !epoch.runSlotHeld
    && record.lastCleanupRecovery?.source === "operator-attested"
    && record.lastCleanupRecovery.workerGeneration === epoch.generation;
}

/**
 * Pure durable classification for a registry loaded after its exact broker
 * owner died. It never proves worker quiescence. Unsafe current epochs keep or
 * gain a quarantine before namespace-wide orphan artifacts can be removed.
 */
export function transitionAbandonedOwnerRecovery(
  source: AgentRecord,
  at = nowIso(),
): AbandonedOwnerRecoveryTransition {
  const record = clone(source);
  if (record.state === "archived") return { record, changed: false };

  const epoch = record.workerEpoch;
  const exactVerifiedClean = epoch?.phase === "verified-clean" && !epoch.runSlotHeld && !record.cleanup;
  const exactReleaseShape = structurallyExactOperatorRelease(record);
  let changed = false;
  // Candidate 19ad1b1 could commit this exact inactive shape before orphan
  // artifact removal. Canonicalize only that narrow prior state; later epochs,
  // cleanup/run holds, and all other lifecycle states remain fail-closed.
  if (exactReleaseShape && record.state === "paused") {
    record.state = "failed";
    record.updatedAt = at;
    changed = true;
  }
  const exactReleased = exactReleaseShape && record.state === "failed";
  const unsafeCurrentEpoch = Boolean(
    epoch
    && (epoch.phase === "spawning" || epoch.phase === "activated")
    && epoch.mutationCapable,
  );
  const unsafeLegacy = !epoch && isConservativeCleanupCapable(record.tools);

  if (!record.cleanup && !exactVerifiedClean && !exactReleased && (unsafeCurrentEpoch || unsafeLegacy)) {
    record.cleanup = {
      state: "unknown",
      reasonCode: "ABANDONED_OWNER_RECOVERY",
      workerGeneration: epoch?.generation ?? 1,
      startedAt: at,
      updatedAt: at,
      abort: "timed-out",
      dispose: "timed-out",
      quiescence: "unknown",
      mutationCapableAtStart: true,
      // A legacy record has no exact epoch receipt proving release of a run
      // slot. A current epoch preserves its durable run-slot fact.
      heldRunSlot: epoch?.runSlotHeld ?? true,
      activeTools: [],
      detail: "The prior broker owner ended abruptly; Pi exposes no receipt proving that its completed or active process-capable tools are quiescent.",
    };
    changed = true;
  }

  if (!record.cleanup) return { record, changed };

  const cleanupOwnerWasLive = record.cleanup.state === "pending"
    || record.cleanup.abort === "pending"
    || record.cleanup.dispose === "pending";
  if (cleanupOwnerWasLive) {
    const priorDetail = record.cleanup.detail;
    record.cleanup.state = "unknown";
    record.cleanup.updatedAt = at;
    if (record.cleanup.abort === "pending") record.cleanup.abort = "timed-out";
    if (record.cleanup.dispose === "pending") record.cleanup.dispose = "timed-out";
    record.cleanup.detail = truncateText(
      `Cleanup promise owner was lost with the prior broker owner; authoritative quiescence remains unknown.${priorDetail ? ` Prior detail: ${priorDetail}` : ""}`,
      1_500,
    );
    changed = true;
  }
  if (record.state !== "failed") { record.state = "failed"; changed = true; }
  const cleanupFailure = `Cleanup quarantine restored for worker generation ${record.cleanup.workerGeneration}; capacity held.`;
  if (!record.failure) { record.failure = cleanupFailure; changed = true; }
  else if (!record.failure.includes("Cleanup quarantine")) {
    record.failure = truncateText(`${record.failure}; ${cleanupFailure}`, 1_500);
    changed = true;
  }
  if (record.currentActivity !== cleanupFailure) { record.currentActivity = cleanupFailure; changed = true; }
  if (changed) record.updatedAt = at;
  return { record, changed };
}
