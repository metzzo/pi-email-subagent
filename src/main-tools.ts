import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import * as TypeBox from "typebox";
import type { AgentBroker } from "./broker.ts";
import type { CleanupRecoveryProposalCapability } from "./confirmed-cleanup-recovery.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { textResult } from "./tool-result.ts";
import type { AgentCapacitySnapshot, AgentInspection, BoundedRequestIds, EmailEnvelope, WaitForRepliesResult } from "./types.ts";
import { byteLength } from "./util.ts";
import { currentBatchHasEffectfulWork } from "./work-ledger.ts";

const errorMessage = safeErrorSummary;
const { Type } = TypeBox;
const { Text } = PiTui;
const PENDING_WAIT_GUIDANCE = "Pending requests remain correlated in durable mail. Ordinary main presentation is attempted when replies arrive, but Pi 0.81.1 exposes no durable sendMessage append acknowledgement. No immediate keepalive rejoin is needed; rejoin the stable request ID for a deliberate collection/status window or after restart/presentation uncertainty.";
const COLLECTION_PRESENTATION_LIMIT = "Collection presentation: at most one live presentation. Pi 0.81.1 exposes no staged tool-result append receipt, so a process crash can leave the mail journal answered before this exact tool result is durably present in the main session. Recover by inspecting Conversation/mail and rejoining the stable request ID; this is not a crash-proof exactly-once guarantee.";

export interface InspectAgentToolDetails {
  inspection?: AgentInspection;
}

export interface WaitForRepliesToolDetails {
  result?: WaitForRepliesResult;
}

export interface CancelRequestToolDetails {
  requestId?: string;
  recipient?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  reason?: string;
}

export interface ManageAgentToolDetails {
  address?: string;
  action?: "stop" | "restart" | "archive" | "clear_failure" | "recover_cleanup";
  state?: string;
  capacity?: AgentCapacitySnapshot;
  holdsActivationLease?: boolean;
  archiveEligible?: boolean;
  workerGeneration?: number;
  recoveryStatus?: "confirmed";
  offline?: boolean;
  nextStep?: string;
}

function compactEnvelopeDetails(envelope: EmailEnvelope | undefined): EmailEnvelope | undefined {
  return envelope ? { ...envelope, message: "[body omitted from structured tool details; see tool text]" } : undefined;
}

function formatBlocker(label: string, blocker: BoundedRequestIds): string | undefined {
  if (blocker.count === 0) return undefined;
  const ids = blocker.requestIds.join(", ");
  const omitted = blocker.omitted ? `${ids ? ", " : ""}+${blocker.omitted} omitted` : "";
  return `${label} ${blocker.count}${ids || omitted ? ` (${ids}${omitted})` : ""}`;
}

function inspectionRecovery(inspection: AgentInspection): string {
  const blockers = inspection.archiveBlockers.queued.count
    + inspection.archiveBlockers.incomingUnanswered.count
    + inspection.archiveBlockers.outgoingUnanswered.count
    + inspection.archiveBlockers.pendingReplies.count;
  if (inspection.cleanup) return "Cleanup quiescence is unknown. manage_agent recover_cleanup may propose release only after the human explicitly said they externally verified this exact generation's quiescence; the live Pi UI always asks the human for exact confirmation before any recovery access. Capacity pressure alone is never authorization. The human-command-only literal /agents recover-cleanup form remains a direct alternative. Restart/archive remain separate explicit actions.";
  if (inspection.lastCleanupRecovery && (inspection.state === "failed" || inspection.state === "paused")) return `Cleanup generation ${inspection.lastCleanupRecovery.workerGeneration} was operator-released, not Pi-verified. Explicitly restart or archive as appropriate; queued obligations remain authoritative.`;
  if (!inspection.exists && !inspection.capacityAvailable) return "Reuse a known relevant identity or ask main to resolve real obligations and archive a clean identity before retrying.";
  if (inspection.state === "archived") return "Restoration needs a free identity lease; reuse a leased identity or archive another clean identity first.";
  if (inspection.state === "paused" && !inspection.holdsActivationLease) return "This overflow identity needs free identity capacity before restart; retain or resolve its obligations through main.";
  if ((inspection.state === "stopped" || inspection.state === "failed") && blockers > 0) {
    return "Restart this inactive identity to finish real obligations. Cancel only an explicitly abandoned exact request after final validation; archive only after blockers are clear.";
  }
  if (inspection.archiveEligible && inspection.holdsActivationLease) {
    return "Reuse this identity if relevant, or archive this clean identity when it is no longer needed; stop alone does not free its lease.";
  }
  if (inspection.holdsActivationLease) return "Reuse this relevant identity and finish real obligations; stop only to become inactive and never to free its lease.";
  return "Ask main to resolve obligations and obtain identity capacity before retrying.";
}

function compactWaitDetails(result: WaitForRepliesResult): WaitForRepliesResult {
  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      request: compactEnvelopeDetails(item.request),
      reply: compactEnvelopeDetails(item.reply),
    })),
  };
}

export function createMainCoordinationTools(
  getBroker: () => AgentBroker | undefined,
  cleanupRecovery?: CleanupRecoveryProposalCapability,
) {
  const EffortSchema = PiAi.StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
  const inspect = PiCodingAgent.defineTool({
    name: "inspect_agent",
    label: "Inspect agent",
    description:
      "Preview or inspect a virtual email agent without spawning it. For a prospective identity, optional effort previews an initial send override. Returns the effective profile, derived identity-lease and run-slot capacity, exact lease ownership, bounded obligation/archive blockers, lifecycle state, usage, and last failure. Use before delegation or capacity recovery.",
    promptSnippet: "Inspect effective subagent capabilities and state without spawning.",
    promptGuidelines: [
      "Use inspect_agent before sending repository changes when you are not certain the address has edit/write/bash tools.",
      "Role labels do not grant tools; rely on the effective tools returned by inspect_agent.",
    ],
    executionMode: "parallel" as const,
    parameters: Type.Object({
      address: Type.String({ description: "Subagent address to inspect or preview" }),
      effort: Type.Optional(EffortSchema),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        const inspection = broker.inspectAgent(params.address, params.effort);
        const lines = [
          `${inspection.exists ? "Existing" : "Prospective"} agent: ${inspection.address}`,
          `State: ${inspection.state}`,
          `Model: ${inspection.provider}/${inspection.modelId} · effort ${inspection.effort}`,
          inspection.exists
            ? `Binding: persisted exact provider/model${inspection.providerReady === "unavailable" ? " · unavailable in current catalog · no provider substitution" : " · existing identity ignores current main-provider preference"}`
            : "Selection: prospective provider/model under the current main-provider preference; the first accepted mail persists it",
          `Role: ${inspection.role} · ${inspection.writable ? "writable" : "read-only"} · ${inspection.canSpawn ? "can delegate" : "delegation disabled"}`,
          `Tools: ${inspection.tools.join(", ")}`,
          `Identity capacity: ${inspection.capacity.identitiesUsed}/${inspection.capacity.identitiesLimit} used · this address holds a lease: ${inspection.holdsActivationLease ? "yes" : "no"} · capacity available for this address: ${inspection.capacityAvailable ? "yes" : "no"}`,
          `Run concurrency: ${inspection.capacity.runSlotsUsed}/${inspection.capacity.runSlotsLimit} slots used`,
          `Mailbox: ${inspection.queued} queued · ${inspection.unanswered} incoming unanswered · ${inspection.outgoingUnanswered} outgoing unanswered · ${inspection.pendingReplies} pending replies`,
          `Archive eligible: ${inspection.archiveEligible ? "yes" : "no"}`,
          `Lifecycle: ${JSON.stringify(inspection.lifecycle)}`,
        ];
        const blockerDetails = [
          inspection.archiveBlockers.active ? "active worker" : undefined,
          inspection.archiveBlockers.cleanupQuarantine ? "cleanup quiescence unknown" : undefined,
          formatBlocker("queued", inspection.archiveBlockers.queued),
          formatBlocker("incoming unanswered", inspection.archiveBlockers.incomingUnanswered),
          formatBlocker("outgoing unanswered", inspection.archiveBlockers.outgoingUnanswered),
          formatBlocker("reply delivery pending", inspection.archiveBlockers.pendingReplies),
        ].filter((value): value is string => Boolean(value));
        if (blockerDetails.length) lines.push(`Archive blockers: ${blockerDetails.join(" · ")}`);
        lines.push(`Recovery: ${inspectionRecovery(inspection)}`);
        if (inspection.cleanup) {
          lines.push(`Cleanup: ${inspection.cleanup.state} · quiescence unknown · activation held · restart/archive blocked · queued mail preserved`);
          lines.push(`Cleanup phases: abort ${inspection.cleanup.abort} · dispose ${inspection.cleanup.dispose} · generation ${inspection.cleanup.workerGeneration} · mutation-capable at start ${inspection.cleanup.mutationCapableAtStart ? "yes" : "no"} · run slot held ${inspection.cleanup.heldRunSlot ? "yes" : "no"}`);
        }
        if (inspection.lastCleanupRecovery) {
          lines.push(`Last cleanup operator release: generation ${inspection.lastCleanupRecovery.workerGeneration} · ${inspection.lastCleanupRecovery.source} · ${inspection.lastCleanupRecovery.releasedAt} · not Pi-verified · evidence retained in the durable audit`);
        }
        if (inspection.failure) {
          lines.push(`Last failure: ${inspection.failure}`);
          const record = broker.getSnapshot().agents.find((agent) => agent.address === inspection.address);
          if (record?.activity.some((item) => item.summary === "Agent run failed")) {
            const open = broker.mailStore.list().filter((email) => email.to === inspection.address
              && email.kind === "request"
              && email.requiresResponse
              && email.deliveryState === "delivered"
              && !email.answeredAt).length;
            const obligation = open === 0
              ? "No delivered requests remain unanswered."
              : `${open} delivered request${open === 1 ? "" : "s"} remain${open === 1 ? "s" : ""} unanswered.`;
            const effects = currentBatchHasEffectfulWork(record.work)
              ? "Current batch includes mutation/shell/custom work; effects may exist. Inspect Work and Conversation before explicit same-identity restart. Do not redelegate this possible-effect scope while the original obligation remains open."
              : "No mutation/shell/custom effect is recorded in the current work ledger; this is not proof of pre-tool failure. Inspect Conversation before explicit same-identity restart. Do not redelegate this possible-effect scope while the original obligation remains open.";
            lines.push(`Terminal worker run failure · ${inspection.provider}/${inspection.modelId} · provider/network cause may be external or unclear. ${obligation} ${effects}`);
          }
        }
        return textResult(lines.join("\n"), { inspection } satisfies InspectAgentToolDetails);
      } catch (error) {
        throw new Error(`Could not inspect agent: ${errorMessage(error)}`);
      }
    },
  });

  const wait = PiCodingAgent.defineTool({
    name: "wait_for_replies",
    label: "Wait for replies",
    description:
      "Join already-sent response-required email requests in a bounded collection window until each is answered, failed, stopped, archived, paused without a live worker, or the timeout ends the window. Returns completed and pending results together. Collection suppresses a separate live turn and is at-most-one live presentation, not crash-proof exactly once: Pi 0.81.1 has no staged tool-result append receipt. After a pending timeout, late replies remain durable and ordinary main presentation is attempted without a durable append receipt.",
    promptSnippet: "Open a bounded observation window for replies to delegated email request IDs.",
    promptGuidelines: [
      "Use request IDs returned by send_email; never invent IDs.",
      "Use wait_for_replies instead of polling registry files or sending progress mail.",
      "Do not immediately rejoin merely to keep pending requests alive. Rejoin for a deliberate synchronous collection/status window or after restart/presentation uncertainty.",
    ],
    executionMode: "sequential" as const,
    parameters: Type.Object({
      request_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 300, default: 120 })),
      collect: Type.Optional(Type.Boolean({ default: true })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      try {
        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        const result = await broker.waitForReplies(
          params.request_ids,
          (params.timeout_seconds ?? 120) * 1_000,
          params.collect ?? true,
          signal,
        );
        const lines = [
          `Replies: ${result.complete ? "complete" : result.timedOut ? "timed out with pending work" : "partial"}`,
          ...((params.collect ?? true) ? [COLLECTION_PRESENTATION_LIMIT] : []),
        ];
        const omitted: string[] = [];
        for (const item of result.items) {
          const subject = item.reply?.subject ?? item.request?.subject ?? item.requestId;
          const suffix = item.error ? ` · ${item.error}` : "";
          const summary = `- ${item.requestId}: ${item.state} · ${subject}${suffix}`;
          const full = `${summary}${item.reply ? `\n  ${item.reply.message}` : ""}`;
          if (item.reply && byteLength([...lines, full].join("\n")) > broker.toolResultByteLimit) {
            lines.push(`${summary}\n  [reply body omitted from this batch; call wait_for_replies again with only ${item.requestId}]`);
            omitted.push(item.requestId);
          } else lines.push(full);
        }
        if (omitted.length > 0) {
          lines.push(`Re-fetch omitted reply bodies in smaller groups: ${omitted.join(", ")}`);
        }
        if (result.timedOut && result.items.some((item) => item.state === "pending")) {
          lines.push("", PENDING_WAIT_GUIDANCE);
        }
        return textResult(lines.join("\n"), { result: compactWaitDetails(result) } satisfies WaitForRepliesToolDetails);
      } catch (error) {
        throw new Error(`Could not wait for replies: ${errorMessage(error)}`);
      }
    },
  });

  const cancel = PiCodingAgent.defineTool({
    name: "cancel_request",
    label: "Cancel request",
    description:
      "Administratively close one exact response obligation without fabricating a reply. Main-thread only. The recipient must already be inactive (failed, stopped, paused, or archived), and a bounded substantive audit reason is required. This does not stop active work; stop the recipient first.",
    promptSnippet: "Cancel an abandoned request to an inactive subagent by its real correlation ID.",
    promptGuidelines: [
      "Cancel only when the user has explicitly abandoned the request or its inactive recipient cannot safely resume.",
      "Never cancel merely to hide an unanswered count; preserve the substantive reason for the audit journal.",
    ],
    executionMode: "sequential" as const,
    parameters: Type.Object({
      request_id: Type.String({ minLength: 1, description: "Exact request/correlation ID returned by send_email" }),
      reason: Type.String({ minLength: 8, maxLength: 1024, description: "Why this obligation is being intentionally abandoned" }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        const request = await broker.cancelRequest(params.request_id, params.reason);
        const details: CancelRequestToolDetails = {
          requestId: request.id,
          recipient: request.to,
          cancelledAt: request.cancelledAt,
          cancelledBy: request.cancelledBy,
          reason: request.cancellationReason,
        };
        return textResult(
          `Cancelled request ${request.id} to ${request.to}.\nReason: ${request.cancellationReason}`,
          details,
        );
      } catch (error) {
        throw new Error(`Could not cancel request: ${errorMessage(error)}`);
      }
    },
  });

  const manage = PiCodingAgent.defineTool({
    name: "manage_agent",
    label: "Manage agent",
    description:
      "Control an existing email agent without assigning work. Main-thread only. Stop retains the identity lease; restart resumes the same persistent work; only verified clean archive releases identity capacity. recover_cleanup is only a proposal for an exact quarantined generation: it requires the human's bounded external-quiescence statement and always opens a live Pi UI confirmation before any online/offline recovery access. Model text alone has no authority. Cancellation of explicitly abandoned exact requests is separate.",
    promptSnippet: "Stop, restart, archive, clear a failure, or propose exact-generation cleanup recovery for human confirmation.",
    promptGuidelines: [
      "Stop only to make work inactive; it does not free maxAgents identity capacity.",
      "Cancel only explicitly abandoned exact requests after the recipient is inactive, then archive only when all blockers are clear.",
      "Before restarting a failed agent, inspect its current-batch Work and native Conversation; explicitly restart the same identity only after accounting for possible effects.",
      "Use manage_agent recover_cleanup only when the user explicitly said they externally verified the exact worker generation's quiescence; quote or summarize that statement in operatorEvidence.",
      "manage_agent recover_cleanup always asks the human to confirm through the live Pi UI; model-generated evidence without affirmative UI confirmation has zero authority, and capacity pressure is never authorization.",
      "A model must not invoke the literal /agents recover-cleanup command or claim approval; report only whether the proposal was confirmed or rejected and the separate /reload, restart, or archive next step.",
    ],
    executionMode: "sequential" as const,
    parameters: Type.Object({
      address: Type.String({ description: "Exact existing subagent address" }),
      action: PiAi.StringEnum(["stop", "restart", "archive", "clear_failure", "recover_cleanup"] as const),
      workerGeneration: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Required only for recover_cleanup: exact positive quarantined worker generation",
      })),
      operatorEvidence: Type.Optional(Type.String({
        minLength: 8,
        maxLength: 1_024,
        description: "Required only for recover_cleanup: bounded quote or summary of what the human said they externally verified",
      })),
    }, { additionalProperties: false }),
    renderCall(args, theme) {
      const action = errorMessage(String(args.action ?? ""));
      const address = errorMessage(String(args.address ?? ""));
      const generation = args.action === "recover_cleanup" && args.workerGeneration !== undefined
        ? ` generation ${args.workerGeneration}`
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("manage_agent "))}${theme.fg("accent", action)} ${theme.fg("muted", address)}${theme.fg("warning", generation)}`,
        0,
        0,
      );
    },
    async execute(id, params, signal) {
      try {
        const hasWorkerGeneration = params.workerGeneration !== undefined;
        const hasOperatorEvidence = params.operatorEvidence !== undefined;
        if (params.action !== "recover_cleanup" && (hasWorkerGeneration || hasOperatorEvidence)) {
          throw new Error("workerGeneration and operatorEvidence are recovery-only fields allowed only with recover_cleanup.");
        }
        if (params.action === "recover_cleanup") {
          if (!hasWorkerGeneration || !hasOperatorEvidence) {
            throw new Error("recover_cleanup requires exact workerGeneration and operatorEvidence.");
          }
          if (!cleanupRecovery) {
            throw new Error("Cleanup recovery confirmation capability is unavailable; model text was not authorized.");
          }
          const result = await cleanupRecovery.propose(id, {
            address: params.address,
            workerGeneration: params.workerGeneration!,
            operatorEvidence: params.operatorEvidence!,
          }, signal);
          const nextStep = result.offline
            ? result.nextStep
            : "Explicitly restart or archive the same identity next.";
          return textResult(
            `recover_cleanup confirmed for ${result.address}, generation ${result.audit.workerGeneration}. The operator-attested release is not Pi-verified. State: failed.\n${nextStep}`,
            {
              address: result.address,
              action: "recover_cleanup",
              state: "failed",
              workerGeneration: result.audit.workerGeneration,
              recoveryStatus: "confirmed",
              offline: result.offline,
              ...(result.nextStep ? { nextStep: result.nextStep } : {}),
            } satisfies ManageAgentToolDetails,
          );
        }

        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        if (params.action === "stop") await broker.stop(params.address);
        else if (params.action === "restart") await broker.restart(params.address);
        else if (params.action === "archive") await broker.archive(params.address);
        else if (params.action === "clear_failure") await broker.clearFailure(params.address);
        else throw new Error(`Unsupported manage_agent action: ${String((params as { action?: unknown }).action)}.`);
        const inspection = broker.inspectAgent(params.address);
        const state = inspection.state;
        const capacityText = `Identity capacity: ${inspection.capacity.identitiesUsed}/${inspection.capacity.identitiesLimit} activation leases used · run concurrency: ${inspection.capacity.runSlotsUsed}/${inspection.capacity.runSlotsLimit} slots used.`;
        const actionText = params.action === "stop"
          ? `Identity lease remains ${inspection.holdsActivationLease ? "held" : "free"}; stop alone does not free maxAgents identity capacity.`
          : params.action === "restart"
            ? "The same persistent session and mailbox are resumed; genuine obligations remain authoritative."
            : params.action === "archive"
              ? `Identity lease released: ${inspection.holdsActivationLease ? "no" : "yes"}.`
              : "Clearing a failure diagnostic does not resolve or cancel any obligation.";
        return textResult(
          `${params.action} completed for ${params.address}. State: ${state}.\n${actionText} ${capacityText}`,
          {
            address: params.address,
            action: params.action,
            state,
            capacity: inspection.capacity,
            holdsActivationLease: inspection.holdsActivationLease,
            archiveEligible: inspection.archiveEligible,
          } satisfies ManageAgentToolDetails,
        );
      } catch (error) {
        throw new Error(`Could not manage agent: ${errorMessage(error)}`);
      }
    },
  });

  return [inspect, wait, cancel, manage] as const;
}
