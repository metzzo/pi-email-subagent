import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MAX_CONFIG_PROFILE_TOOLS, MAX_CONFIG_TOOL_NAME_BYTES, MAX_CONFIG_WARNINGS } from "./config.ts";

export const WORKER_EXTENSION_COLLECT_EVENT = "pi-email-subagent:collect-worker-extensions";
export const WORKER_EXTENSION_PROTOCOL_VERSION = 1;
const MAX_WORKER_EXTENSIONS = 16;
const RESERVED_TOOL_NAMES = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "send_email", "fetch_emails", "inspect_agent", "wait_for_replies", "cancel_request", "manage_agent",
] as const;

export interface WorkerExtensionRegistration {
  protocolVersion: typeof WORKER_EXTENSION_PROTOCOL_VERSION;
  name: string;
  factory: ExtensionFactory;
  tools: readonly string[];
}

export interface WorkerExtensionCollection {
  registrations: readonly WorkerExtensionRegistration[];
  issues: readonly string[];
}

type EventEmitter = {
  emit(event: string, value: unknown): void;
};

function registrationIssue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return "Ignored a worker extension registration that was not an object.";
  const candidate = value as Partial<WorkerExtensionRegistration>;
  if (candidate.protocolVersion !== WORKER_EXTENSION_PROTOCOL_VERSION) return "Ignored a worker extension registration with an unsupported protocol version.";
  if (typeof candidate.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(candidate.name)) return "Ignored a worker extension registration with an invalid name.";
  if (typeof candidate.factory !== "function") return "Ignored a worker extension registration without a factory.";
  if (!Array.isArray(candidate.tools) || candidate.tools.length > MAX_CONFIG_PROFILE_TOOLS) return "Ignored a worker extension registration with an invalid tool list.";
  if (!candidate.tools.every((tool) => (
    typeof tool === "string" && /^[a-zA-Z0-9_-]+$/.test(tool) && Buffer.byteLength(tool, "utf8") <= MAX_CONFIG_TOOL_NAME_BYTES
  ))) return "Ignored a worker extension registration with an invalid tool name.";
  if (!candidate.tools.every((tool, index) => candidate.tools!.indexOf(tool) === index)) return "Ignored a worker extension registration with duplicate tool names.";
  if (candidate.tools.some((tool) => RESERVED_TOOL_NAMES.includes(tool as typeof RESERVED_TOOL_NAMES[number]))) {
    return "Ignored a worker extension registration that claimed a reserved tool name.";
  }
  return undefined;
}

export function collectWorkerExtensions(events: EventEmitter): WorkerExtensionCollection {
  const registrations: WorkerExtensionRegistration[] = [];
  const issues: string[] = [];
  const noteIssue = (issue: string): void => {
    if (issues.length < MAX_CONFIG_WARNINGS) issues.push(issue);
  };
  const collector = Object.freeze({
    register(value: unknown): void {
      const issue = registrationIssue(value);
      if (issue) {
        noteIssue(issue);
        return;
      }
      const registration = value as WorkerExtensionRegistration;
      if (registrations.length >= MAX_WORKER_EXTENSIONS) {
        noteIssue("Ignored a worker extension registration because the registration limit was reached.");
        return;
      }
      if (registrations.some((candidate) => candidate.name === registration.name)) {
        noteIssue("Ignored a duplicate worker extension registration name.");
        return;
      }
      if (registration.tools.some((tool) => registrations.some((candidate) => candidate.tools.includes(tool)))) {
        noteIssue("Ignored a worker extension registration with a colliding tool name.");
        return;
      }
      const totalTools = registrations.reduce((total, candidate) => total + candidate.tools.length, 0) + registration.tools.length;
      if (totalTools > MAX_CONFIG_PROFILE_TOOLS) {
        noteIssue("Ignored a worker extension registration because the combined tool limit was reached.");
        return;
      }
      registrations.push(Object.freeze({
        protocolVersion: WORKER_EXTENSION_PROTOCOL_VERSION,
        name: registration.name,
        factory: registration.factory,
        tools: Object.freeze([...registration.tools]),
      }));
    },
  });
  events.emit(WORKER_EXTENSION_COLLECT_EVENT, collector);
  return Object.freeze({
    registrations: Object.freeze([...registrations]),
    issues: Object.freeze([...issues]),
  });
}
