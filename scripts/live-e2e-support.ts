import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseMailEvent, type MailEvent } from "../src/mail-store.ts";
import { parseRegistry } from "../src/registry-store.ts";

const MAX_REASONS = 32;
const MAX_REASON_CHARS = 240;
const SAFE_SESSION_ID = /^[a-zA-Z0-9-]{1,128}$/u;

export interface LiveExpectations {
  provider: string;
  modelId: string;
  mainAddress: string;
  recipientAddress: string;
  subject: string;
}

interface LiveRequestObservation {
  id: string;
  from: string;
  to: string;
  subject: string;
  expectedReplySubject: string;
  provider: string;
  modelId: string;
}

interface LiveReplyObservation {
  id: string;
  requestId: string;
  from: string;
  to: string;
  subject: string;
}

export interface LiveRpcState {
  sessionIds: string[];
  getStateResponses: number;
  promptResponses: number;
  successfulSendCount: number;
  toolErrorCount: number;
  extensionErrorCount: number;
  incompleteReplyCount: number;
  terminalAgentEnd: boolean;
  mainSettled: boolean;
  request?: LiveRequestObservation;
  reply?: LiveReplyObservation;
  protocolErrors: string[];
}

export interface LiveRunValidationInput {
  state: LiveRpcState;
  expectations: LiveExpectations;
  childExitCode: number | null;
  timedOut: boolean;
}

export interface LiveNamespaceInspection {
  registryValidated: boolean;
  journalValidated: boolean;
  agentState?: string;
  workerEpochPhase?: string;
  workerEpochRunSlotHeld?: boolean;
  cleanupPresent?: boolean;
  lockDirectoryExists: boolean;
  ownerSidecarExists: boolean;
  journalEventTypes: string[];
}

export interface LiveFinalizationOptions extends LiveRunValidationInput {
  namespaceDir: string;
  evidenceDir: string;
}

export interface LiveFinalizationResult {
  ok: boolean;
  removed: boolean;
  preserved: boolean;
  evidencePath?: string;
  evidenceValidated: boolean;
  reasons: string[];
  inspection?: LiveNamespaceInspection;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function addReason(reasons: string[], reason: string): void {
  const bounded = reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_REASON_CHARS);
  if (!bounded || reasons.includes(bounded) || reasons.length >= MAX_REASONS) return;
  reasons.push(bounded);
}

function sameReply(left: LiveReplyObservation, right: LiveReplyObservation): boolean {
  return left.id === right.id
    && left.requestId === right.requestId
    && left.from === right.from
    && left.to === right.to
    && left.subject === right.subject;
}

function parseReplyObservation(value: unknown, request: LiveRequestObservation): LiveReplyObservation | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const id = nonempty(raw.id);
  const requestId = nonempty(raw.inReplyTo);
  const from = nonempty(raw.from);
  const to = nonempty(raw.to);
  const subject = nonempty(raw.subject);
  if (!id || !requestId || !from || !to || !subject
    || raw.kind !== "reply"
    || raw.requiresResponse !== false
    || requestId !== request.id
    || from.toLowerCase() !== request.to
    || to.toLowerCase() !== request.from
    || subject !== request.expectedReplySubject) return undefined;
  return { id, requestId, from: from.toLowerCase(), to: to.toLowerCase(), subject };
}

function recordReply(state: LiveRpcState, reply: LiveReplyObservation): void {
  if (state.reply && !sameReply(state.reply, reply)) {
    addReason(state.protocolErrors, "multiple non-identical replies were observed for the live request");
    return;
  }
  state.reply = reply;
}

function parseSendObservation(state: LiveRpcState, event: Record<string, unknown>, expected: LiveExpectations): void {
  const result = object(object(object(event.result)?.details)?.result);
  const envelope = object(result?.envelope);
  const binding = object(envelope?.modelBindingIntent);
  const id = nonempty(result?.correlationId);
  const envelopeId = nonempty(envelope?.id);
  const from = nonempty(envelope?.from)?.toLowerCase();
  const to = nonempty(envelope?.to)?.toLowerCase();
  const subject = nonempty(envelope?.subject);
  const provider = nonempty(result?.recipientProvider);
  const modelId = nonempty(result?.recipientModel);
  const replySubject = nonempty(result?.expectedReplySubject);
  const exactReplySubject = id && subject ? `Re: [${id}] ${subject}` : undefined;
  if (!id || !envelopeId || id !== envelopeId
    || !from || from !== expected.mainAddress.toLowerCase()
    || !to || to !== expected.recipientAddress.toLowerCase()
    || subject !== expected.subject
    || envelope?.kind !== "request"
    || envelope?.requiresResponse !== true
    || provider !== expected.provider
    || modelId !== expected.modelId
    || nonempty(binding?.provider) !== expected.provider
    || nonempty(binding?.modelId) !== expected.modelId
    || !replySubject || replySubject !== exactReplySubject) {
    addReason(state.protocolErrors, "send_email returned malformed or mismatched stable correlation evidence");
    return;
  }
  const request: LiveRequestObservation = {
    id,
    from,
    to,
    subject,
    expectedReplySubject: replySubject,
    provider,
    modelId,
  };
  if (state.request && JSON.stringify(state.request) !== JSON.stringify(request)) {
    addReason(state.protocolErrors, "successful send_email calls returned non-identical request evidence");
    return;
  }
  state.request = request;
}

function parseWaitObservation(state: LiveRpcState, event: Record<string, unknown>): void {
  const result = object(object(object(event.result)?.details)?.result);
  const items = result?.items;
  if (!state.request || result?.complete !== true || result?.timedOut !== false
    || !Array.isArray(items) || items.length !== 1) {
    state.incompleteReplyCount += 1;
    addReason(state.protocolErrors, "wait_for_replies did not return one complete answered request");
    return;
  }
  const item = object(items[0]);
  const reply = parseReplyObservation(item?.reply, state.request);
  if (!item || item.requestId !== state.request.id || item.state !== "answered" || !reply) {
    state.incompleteReplyCount += 1;
    addReason(state.protocolErrors, "wait_for_replies returned incomplete or mismatched reply correlation");
    return;
  }
  recordReply(state, reply);
}

export function createLiveRpcState(): LiveRpcState {
  return {
    sessionIds: [],
    getStateResponses: 0,
    promptResponses: 0,
    successfulSendCount: 0,
    toolErrorCount: 0,
    extensionErrorCount: 0,
    incompleteReplyCount: 0,
    terminalAgentEnd: false,
    mainSettled: false,
    protocolErrors: [],
  };
}

/** Reduce one parsed Pi RPC record without retaining model text, tool arguments, or provider diagnostics. */
export function reduceLiveRpcEvent(state: LiveRpcState, value: unknown, expected: LiveExpectations): void {
  const event = object(value);
  if (!event) {
    addReason(state.protocolErrors, "Pi RPC emitted a non-object JSON record");
    return;
  }
  const type = nonempty(event.type);
  if (type === "agent_start") {
    state.terminalAgentEnd = false;
    state.mainSettled = false;
    return;
  }
  if (type === "agent_end") {
    state.terminalAgentEnd = event.willRetry === false;
    state.mainSettled = false;
    return;
  }
  if (type === "agent_settled") {
    state.mainSettled = true;
    return;
  }
  if (type === "extension_error") {
    state.extensionErrorCount += 1;
    return;
  }
  if (type === "response" && event.command === "get_state") {
    state.getStateResponses += 1;
    const sessionId = nonempty(object(event.data)?.sessionId);
    if (event.success !== true || !sessionId || !SAFE_SESSION_ID.test(sessionId)) {
      addReason(state.protocolErrors, "get_state did not return one safe session ID");
    } else state.sessionIds.push(sessionId);
    return;
  }
  if (type === "response" && event.command === "prompt") {
    state.promptResponses += 1;
    if (event.success !== true) addReason(state.protocolErrors, "the live prompt RPC command failed");
    return;
  }
  if (type === "tool_execution_end") {
    if (event.isError !== true && event.isError !== false) {
      addReason(state.protocolErrors, "a tool result omitted its canonical error flag");
      return;
    }
    if (event.isError) {
      state.toolErrorCount += 1;
      return;
    }
    if (event.toolName === "send_email") {
      state.successfulSendCount += 1;
      parseSendObservation(state, event, expected);
    } else if (event.toolName === "wait_for_replies") parseWaitObservation(state, event);
    return;
  }
  if (type === "message_start") {
    const message = object(event.message);
    if (message?.customType !== "pi-email-subagent.email" || !state.request) return;
    const reply = parseReplyObservation(message.details, state.request);
    if (!reply) addReason(state.protocolErrors, "incoming live email had incomplete or mismatched reply correlation");
    else recordReply(state, reply);
  }
}

/** A full main-session boundary is required even when the correlated reply arrived earlier. */
export function readyForShutdownGrace(state: LiveRpcState): boolean {
  return state.terminalAgentEnd && state.mainSettled;
}

export function validateLiveRpc(input: LiveRunValidationInput): string[] {
  const { state } = input;
  const reasons = [...state.protocolErrors];
  if (input.timedOut) addReason(reasons, "live provider run timed out");
  if (input.childExitCode !== 0) addReason(reasons, `Pi child exit was not clean (code ${String(input.childExitCode)})`);
  if (state.getStateResponses !== 1 || state.sessionIds.length !== 1) addReason(reasons, "expected exactly one successful get_state response");
  if (state.promptResponses !== 1) addReason(reasons, "expected exactly one successful prompt response");
  if (state.successfulSendCount !== 1 || !state.request) addReason(reasons, "expected exactly one successful send_email with stable request evidence");
  if (!state.reply) addReason(reasons, "expected one complete, exactly correlated answered reply");
  if (state.incompleteReplyCount !== 0) addReason(reasons, "an incomplete reply observation occurred");
  if (state.toolErrorCount !== 0) addReason(reasons, `${state.toolErrorCount} tool error(s) occurred`);
  if (state.extensionErrorCount !== 0) addReason(reasons, `${state.extensionErrorCount} extension error(s) occurred`);
  if (!state.terminalAgentEnd || !state.mainSettled) addReason(reasons, "the main agent did not reach its final settled boundary");
  if (state.request) {
    if (state.request.provider !== input.expectations.provider || state.request.modelId !== input.expectations.modelId) {
      addReason(reasons, "send_email provider/model binding did not match the expected live model");
    }
    if (state.request.from !== input.expectations.mainAddress.toLowerCase()
      || state.request.to !== input.expectations.recipientAddress.toLowerCase()
      || state.request.subject !== input.expectations.subject) {
      addReason(reasons, "send_email request identity did not match the exact live request");
    }
  }
  if (state.request && state.reply && (state.reply.requestId !== state.request.id
    || state.reply.from !== state.request.to
    || state.reply.to !== state.request.from
    || state.reply.subject !== state.request.expectedReplySubject)) {
    addReason(reasons, "observed reply did not match the exact stable request correlation");
  }
  return reasons;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exactEvent<T extends MailEvent["type"]>(event: MailEvent | undefined, type: T): Extract<MailEvent, { type: T }> | undefined {
  return event?.type === type ? event as Extract<MailEvent, { type: T }> : undefined;
}

async function inspectNamespace(
  namespaceDir: string,
  expected: LiveExpectations,
  request: LiveRequestObservation | undefined,
  reply: LiveReplyObservation | undefined,
  reasons: string[],
): Promise<LiveNamespaceInspection | undefined> {
  const inspection: LiveNamespaceInspection = {
    registryValidated: false,
    journalValidated: false,
    lockDirectoryExists: false,
    ownerSidecarExists: false,
    journalEventTypes: [],
  };
  try {
    inspection.lockDirectoryExists = await pathExists(`${namespaceDir}.lock`);
    inspection.ownerSidecarExists = await pathExists(join(namespaceDir, ".broker-owner.json"));
  } catch {
    addReason(reasons, "namespace ownership evidence could not be inspected");
  }
  if (inspection.lockDirectoryExists) addReason(reasons, "namespace lock directory remains present after child close");
  if (inspection.ownerSidecarExists) addReason(reasons, "namespace owner sidecar remains present after child close");

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(namespaceDir, "registry.json"), "utf8"));
    } catch {
      addReason(reasons, "namespace registry JSON is missing or malformed");
      parsed = undefined;
    }
    if (parsed !== undefined) {
      try {
        const registry = parseRegistry(parsed);
        inspection.registryValidated = true;
        if (registry.mainAddress !== expected.mainAddress.toLowerCase()
          || !registry.mainAliases.includes(expected.mainAddress.toLowerCase())) {
          addReason(reasons, "registry main identity does not match the expected live model");
        }
        if (registry.agents.length !== 1) addReason(reasons, "registry does not contain exactly one live worker identity");
        const agent = registry.agents.find((candidate) => candidate.address === expected.recipientAddress.toLowerCase());
        if (!agent) addReason(reasons, "registry is missing the exact live worker identity");
        else {
          inspection.agentState = agent.state;
          inspection.cleanupPresent = Boolean(agent.cleanup);
          inspection.workerEpochPhase = agent.workerEpoch?.phase;
          inspection.workerEpochRunSlotHeld = agent.workerEpoch?.runSlotHeld;
          if (agent.provider !== expected.provider || agent.modelId !== expected.modelId) {
            addReason(reasons, "registry worker provider/model binding does not match the expected live model");
          }
          if (agent.state !== "paused") addReason(reasons, "registry worker is not paused after clean child shutdown");
          if (agent.cleanup) addReason(reasons, "registry contains a cleanup quarantine or unknown cleanup diagnostic");
          if (!agent.workerEpoch || agent.workerEpoch.phase !== "session-settled") {
            addReason(reasons, "registry worker epoch is not Pi session/tool settled");
          }
          if (agent.workerEpoch?.runSlotHeld !== false) addReason(reasons, "registry worker epoch still holds or omits its run-slot release");
        }
        if (registry.agents.some((agent) => agent.cleanup)) addReason(reasons, "at least one registry identity has Pi session/tool cleanup settlement unknown");
        if (registry.agents.some((agent) => agent.workerEpoch?.runSlotHeld !== false)) {
          addReason(reasons, "at least one registry identity has a held or unverified run slot");
        }
      } catch {
        addReason(reasons, "namespace registry failed the production schema parser");
      }
    }
  } catch {
    addReason(reasons, "namespace registry inspection failed");
  }

  let events: MailEvent[] | undefined;
  try {
    const raw = await readFile(join(namespaceDir, "mail.jsonl"), "utf8");
    const lines = raw.split("\n");
    events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        addReason(reasons, `mail journal JSONL is malformed at line ${index + 1}`);
        events = undefined;
        break;
      }
      try {
        events.push(parseMailEvent(value));
      } catch {
        addReason(reasons, `mail journal failed the production schema parser at line ${index + 1}`);
        events = undefined;
        break;
      }
    }
  } catch {
    addReason(reasons, "mail journal is missing or unreadable");
  }

  if (events) {
    inspection.journalEventTypes = events.map((event) => event.type);
    const expectedTypes: MailEvent["type"][] = [
      "email.created",
      "email.delivered",
      "email.created",
      "email.reply_reserved",
      "email.delivered",
      "email.answered",
    ];
    if (events.length !== expectedTypes.length || events.some((event, index) => event.type !== expectedTypes[index])) {
      addReason(reasons, "mail journal does not contain the exact six-event request/reply transition");
    } else if (!request || !reply) addReason(reasons, "RPC correlation evidence is incomplete for journal validation");
    else {
      const requestCreated = exactEvent(events[0], "email.created")?.email;
      const requestDelivered = exactEvent(events[1], "email.delivered");
      const replyCreated = exactEvent(events[2], "email.created")?.email;
      const reserved = exactEvent(events[3], "email.reply_reserved");
      const replyDelivered = exactEvent(events[4], "email.delivered");
      const answered = exactEvent(events[5], "email.answered");
      const exact = requestCreated?.id === request.id
        && requestCreated.from.toLowerCase() === expected.mainAddress.toLowerCase()
        && requestCreated.to.toLowerCase() === expected.recipientAddress.toLowerCase()
        && requestCreated.subject === expected.subject
        && requestCreated.kind === "request"
        && requestCreated.requiresResponse === true
        && requestCreated.deliveryState === "queued"
        && requestCreated.modelBindingIntent?.provider === expected.provider
        && requestCreated.modelBindingIntent?.modelId === expected.modelId
        && requestDelivered?.id === request.id
        && replyCreated?.id === reply.id
        && replyCreated.from.toLowerCase() === expected.recipientAddress.toLowerCase()
        && replyCreated.to.toLowerCase() === expected.mainAddress.toLowerCase()
        && replyCreated.subject === request.expectedReplySubject
        && replyCreated.kind === "reply"
        && replyCreated.inReplyTo === request.id
        && replyCreated.requiresResponse === false
        && replyCreated.deliveryState === "queued"
        && reserved?.id === request.id
        && reserved.replyId === reply.id
        && replyDelivered?.id === reply.id
        && answered?.id === request.id
        && answered.replyId === reply.id;
      if (!exact) addReason(reasons, "mail journal stable IDs, identities, subject, or provider/model correlation do not match");
      else inspection.journalValidated = true;
    }
  }
  return inspection;
}

function evidenceFileName(state: LiveRpcState): string {
  const sessionId = state.sessionIds.length === 1 ? state.sessionIds[0] : undefined;
  return `live-${sessionId && SAFE_SESSION_ID.test(sessionId) ? sessionId : `unknown-${process.pid}`}.json`;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** Validate canonical state, persist a secret-free evidence summary, then and only then remove a clean namespace. */
export async function finalizeLiveRun(options: LiveFinalizationOptions): Promise<LiveFinalizationResult> {
  const reasons = validateLiveRpc(options);
  let inspection: LiveNamespaceInspection | undefined;
  const namespacePresent = await pathExists(options.namespaceDir).catch(() => false);
  if (!namespacePresent) addReason(reasons, "live namespace is missing after child close");
  else inspection = await inspectNamespace(
    options.namespaceDir,
    options.expectations,
    options.state.request,
    options.state.reply,
    reasons,
  );

  const evidencePath = join(resolve(options.evidenceDir), evidenceFileName(options.state));
  if (isWithin(options.namespaceDir, evidencePath)) addReason(reasons, "evidence output must be outside the removable live namespace");
  const evidence = {
    schemaVersion: 1,
    clean: reasons.length === 0,
    sessionId: options.state.sessionIds.length === 1 ? options.state.sessionIds[0] : undefined,
    requestId: options.state.request?.id,
    replyId: options.state.reply?.id,
    provider: options.expectations.provider,
    modelId: options.expectations.modelId,
    mainAddress: options.expectations.mainAddress,
    recipientAddress: options.expectations.recipientAddress,
    rpc: {
      successfulSendCount: options.state.successfulSendCount,
      toolErrorCount: options.state.toolErrorCount,
      extensionErrorCount: options.state.extensionErrorCount,
      incompleteReplyCount: options.state.incompleteReplyCount,
      terminalAgentEnd: options.state.terminalAgentEnd,
      mainSettled: options.state.mainSettled,
      childExitCode: options.childExitCode,
      timedOut: options.timedOut,
    },
    namespace: inspection,
    reasons,
  };
  const payload = `${JSON.stringify(evidence, null, 2)}\n`;
  let evidenceValidated = false;
  try {
    await mkdir(resolve(options.evidenceDir), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, payload, { encoding: "utf8", mode: 0o600 });
    const saved = await readFile(evidencePath, "utf8");
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    if (saved !== payload
      || parsed.schemaVersion !== 1
      || parsed.clean !== evidence.clean
      || parsed.requestId !== evidence.requestId
      || parsed.replyId !== evidence.replyId) throw new Error("evidence readback mismatch");
    evidenceValidated = true;
  } catch {
    addReason(reasons, "live evidence could not be saved and validated");
  }

  let removed = false;
  if (reasons.length === 0 && evidenceValidated && namespacePresent) {
    try {
      await rm(options.namespaceDir, { recursive: true, force: false });
      removed = !(await pathExists(options.namespaceDir));
      if (!removed) addReason(reasons, "clean namespace removal could not be verified");
    } catch {
      addReason(reasons, "clean namespace removal failed");
    }
  }
  if (evidence.clean && reasons.length > 0 && evidenceValidated) {
    const correctedPayload = `${JSON.stringify({ ...evidence, clean: false, reasons }, null, 2)}\n`;
    try {
      await writeFile(evidencePath, correctedPayload, { encoding: "utf8", mode: 0o600 });
      evidenceValidated = await readFile(evidencePath, "utf8") === correctedPayload;
    } catch {
      evidenceValidated = false;
    }
  }
  const preserved = await pathExists(options.namespaceDir).catch(() => false);
  return {
    ok: reasons.length === 0 && evidenceValidated && removed,
    removed,
    preserved,
    evidencePath,
    evidenceValidated,
    reasons,
    ...(inspection ? { inspection } : {}),
  };
}

export function boundedEvidencePath(path: string): string {
  const display = relative(process.cwd(), resolve(path)) || basename(path);
  return display.slice(0, 512);
}
