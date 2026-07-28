import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentBroker } from "./broker.ts";
import type { AgentInspection, WaitForRepliesResult } from "./types.ts";
import { byteLength, errorMessage } from "./util.ts";

export interface InspectAgentToolDetails {
  inspection?: AgentInspection;
  error?: string;
}

export interface WaitForRepliesToolDetails {
  result?: WaitForRepliesResult;
  error?: string;
}

export interface ManageAgentToolDetails {
  address?: string;
  action?: "stop" | "restart" | "archive" | "clear_failure";
  state?: string;
  error?: string;
}

function textResult(text: string, details?: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function createMainCoordinationTools(getBroker: () => AgentBroker | undefined) {
  const inspect = defineTool({
    name: "inspect_agent",
    label: "Inspect agent",
    description:
      "Preview or inspect a virtual email agent without spawning it. Returns the effective model, effort, role, tools, writable/read-only guidance, capacity, mailbox counts, state, usage, and last failure. Use before delegation when recipient capability is uncertain.",
    promptSnippet: "Inspect effective subagent capabilities and state without spawning.",
    promptGuidelines: [
      "Use inspect_agent before sending repository changes when you are not certain the address has edit/write/bash tools.",
      "Role labels do not grant tools; rely on the effective tools returned by inspect_agent.",
    ],
    executionMode: "parallel" as const,
    parameters: Type.Object({
      address: Type.String({ description: "Subagent address to inspect or preview" }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        const inspection = broker.inspectAgent(params.address);
        const lines = [
          `${inspection.exists ? "Existing" : "Prospective"} agent: ${inspection.address}`,
          `State: ${inspection.state}`,
          `Model: ${inspection.provider}/${inspection.modelId} · effort ${inspection.effort}`,
          `Role: ${inspection.role} · ${inspection.writable ? "writable" : "read-only"} · ${inspection.canSpawn ? "can spawn" : "spawn disabled"}`,
          `Tools: ${inspection.tools.join(", ")}`,
          `Capacity available: ${inspection.capacityAvailable ? "yes" : "no"}`,
          `Mailbox: ${inspection.queued} queued · ${inspection.unanswered} unanswered · ${inspection.pendingReplies} pending replies`,
        ];
        if (inspection.failure) lines.push(`Last failure: ${inspection.failure}`);
        return textResult(lines.join("\n"), { inspection } satisfies InspectAgentToolDetails);
      } catch (error) {
        const message = errorMessage(error);
        return textResult(`Could not inspect agent: ${message}`, { error: message } satisfies InspectAgentToolDetails, true);
      }
    },
  });

  const wait = defineTool({
    name: "wait_for_replies",
    label: "Wait for replies",
    description:
      "Join already-sent response-required email requests. Waits until each is answered, failed, stopped, archived, paused without a live worker, or the bounded timeout expires; returns completed and pending results together. With collection enabled, correlated replies do not trigger separate model turns.",
    promptSnippet: "Wait for and collect replies to delegated email request IDs.",
    promptGuidelines: [
      "Use request IDs returned by send_email; never invent IDs.",
      "Use wait_for_replies instead of polling registry files or sending progress mail.",
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
        return textResult(lines.join("\n"), { result } satisfies WaitForRepliesToolDetails);
      } catch (error) {
        const message = errorMessage(error);
        return textResult(`Could not wait for replies: ${message}`, { error: message } satisfies WaitForRepliesToolDetails, true);
      }
    },
  });

  const manage = defineTool({
    name: "manage_agent",
    label: "Manage agent",
    description:
      "Control an existing email agent without assigning work. Main-thread only. Stop, restart, safely archive a clean identity to free capacity, or clear a stale failure diagnostic. Sending email remains the only way to create agents or assign tasks.",
    promptSnippet: "Stop, restart, archive, or clear a failure on an existing subagent.",
    promptGuidelines: ["Archive clean completed identities instead of creating unlimited replacement addresses."],
    executionMode: "sequential" as const,
    parameters: Type.Object({
      address: Type.String({ description: "Existing subagent address" }),
      action: Type.Union([
        Type.Literal("stop"),
        Type.Literal("restart"),
        Type.Literal("archive"),
        Type.Literal("clear_failure"),
      ]),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const broker = getBroker();
        if (!broker) throw new Error("Email broker is not ready.");
        if (params.action === "stop") await broker.stop(params.address);
        else if (params.action === "restart") await broker.restart(params.address);
        else if (params.action === "archive") await broker.archive(params.address);
        else await broker.clearFailure(params.address);
        const state = broker.inspectAgent(params.address).state;
        return textResult(
          `${params.action} completed for ${params.address}. State: ${state}.`,
          { address: params.address, action: params.action, state } satisfies ManageAgentToolDetails,
        );
      } catch (error) {
        const message = errorMessage(error);
        return textResult(`Could not manage agent: ${message}`, { error: message } satisfies ManageAgentToolDetails, true);
      }
    },
  });

  return [inspect, wait, manage] as const;
}
