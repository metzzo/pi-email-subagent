import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeCleanupRecovery,
  normalizeCleanupRecoveryInput,
  type CleanupRecoveryCommandResult,
  type CleanupRecoveryInput,
  type OnlineCleanupRecoveryBroker,
} from "./cleanup-recovery.ts";

export const CLEANUP_RECOVERY_CONFIRMATION_TIMEOUT_MS = 30_000;

export interface CleanupRecoveryProposalInput {
  address: string;
  workerGeneration: number;
  operatorEvidence: string;
}

export interface CleanupRecoveryProposalCapability {
  propose(
    toolCallId: string,
    input: CleanupRecoveryProposalInput,
    signal?: AbortSignal,
  ): Promise<CleanupRecoveryCommandResult>;
}

export interface CleanupRecoverySessionState {
  context: ExtensionContext | undefined;
  generation: number;
  broker: OnlineCleanupRecoveryBroker | undefined;
}

export interface CleanupRecoveryProposalCapabilityOptions {
  getState(): CleanupRecoverySessionState;
  namespaceDir(sessionId: string): string;
  execute?: typeof executeCleanupRecovery;
  confirmationTimeoutMs?: number;
}

function exactInput(input: CleanupRecoveryProposalInput): CleanupRecoveryInput {
  return normalizeCleanupRecoveryInput({
    address: input.address,
    workerGeneration: input.workerGeneration,
    evidence: input.operatorEvidence,
  });
}

function confirmationMessage(input: CleanupRecoveryInput): string {
  return [
    `Address: ${input.address}`,
    `Worker generation: ${input.workerGeneration}`,
    "Evidence:",
    input.evidence,
    "",
    "WARNING: Pi did not prove process quiescence. Surviving effects may overlap with later work.",
    "Confirm one execution for this exact address, generation, and evidence only. This does not restart, restore, archive, deliver mail, or cancel obligations.",
  ].join("\n");
}

function liveUiContext(state: CleanupRecoverySessionState): ExtensionContext {
  const context = state.context;
  if (!context || !context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) {
    throw new Error("Cleanup recovery proposal rejected: a live Pi UI confirmation is unavailable, so recovery was not authorized.");
  }
  return context;
}

function sessionId(context: ExtensionContext): string {
  try {
    const value = context.sessionManager.getSessionId();
    if (!value) throw new Error("missing session ID");
    return value;
  } catch {
    throw new Error("Cleanup recovery proposal rejected: the Pi session context is stale, so recovery was not authorized.");
  }
}

/**
 * Creates the model-proposal boundary. Approval is held only in this stack
 * frame, is bound to one tool call and session generation, and is consumed by
 * at most one immediate shared transition call.
 */
export function createCleanupRecoveryProposalCapability(
  options: CleanupRecoveryProposalCapabilityOptions,
): CleanupRecoveryProposalCapability {
  const execute = options.execute ?? executeCleanupRecovery;
  const timeout = options.confirmationTimeoutMs ?? CLEANUP_RECOVERY_CONFIRMATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("Cleanup recovery confirmation timeout must be positive.");

  return {
    async propose(toolCallId, proposal, signal) {
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new Error("Cleanup recovery proposal rejected: a stable tool-call ID is required.");
      }

      // Capture immutable primitives before prompting. Model text has no
      // authority: this validation only determines what the dialog displays.
      const capturedProposal: CleanupRecoveryProposalInput = {
        address: proposal.address,
        workerGeneration: proposal.workerGeneration,
        operatorEvidence: proposal.operatorEvidence,
      };
      const capturedInput = exactInput(capturedProposal);
      const before = options.getState();
      const context = liveUiContext(before);
      const capturedGeneration = before.generation;
      const capturedSessionId = sessionId(context);

      // Treat the public UI boundary as untrusted at runtime. RPC transports can
      // forward schema-invalid values despite the TypeScript boolean contract.
      let confirmed: unknown;
      try {
        confirmed = await context.ui.confirm(
          "Confirm cleanup recovery proposal",
          confirmationMessage(capturedInput),
          { timeout, ...(signal ? { signal } : {}) },
        );
      } catch {
        throw new Error("Cleanup recovery proposal rejected: the Pi confirmation UI failed closed, so recovery was not authorized.");
      }
      if (confirmed !== true || signal?.aborted) {
        throw new Error(
          "Cleanup recovery proposal rejected: human confirmation was denied, cancelled, timed out, or aborted. No recovery was authorized.",
        );
      }

      // The affirmative result is intentionally not turned into a token. It is
      // valid only in this call frame and is consumed immediately below.
      const after = options.getState();
      const afterContext = liveUiContext(after);
      if (after.generation !== capturedGeneration
        || afterContext !== context
        || sessionId(afterContext) !== capturedSessionId) {
        throw new Error(
          "Cleanup recovery proposal rejected: the session generation changed or its context was replaced while confirmation was open. The confirmation is stale.",
        );
      }

      const recheckedInput = exactInput(capturedProposal);
      if (recheckedInput.address !== capturedInput.address
        || recheckedInput.workerGeneration !== capturedInput.workerGeneration
        || recheckedInput.evidence !== capturedInput.evidence) {
        throw new Error("Cleanup recovery proposal rejected: the exact confirmed tuple changed before execution.");
      }

      // executeCleanupRecovery performs the current online/offline fact reads
      // and exact-generation transition now, after confirmation. Any changed
      // cleanup generation/state fails closed and requires a new proposal.
      return execute(
        recheckedInput,
        after.broker,
        options.namespaceDir(capturedSessionId),
      );
    },
  };
}
