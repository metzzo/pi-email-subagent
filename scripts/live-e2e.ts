#!/usr/bin/env tsx
/**
 * Optional paid live-provider acceptance helper.
 *
 * This intentionally does not run under `npm test`. It streams Pi RPC through
 * a secret-free reducer, waits for a final main-session settlement boundary and
 * bounded grace, then validates the canonical namespace before removing it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  boundedEvidencePath,
  createLiveRpcState,
  finalizeLiveRun,
  readyForShutdownGrace,
  reduceLiveRpcEvent,
  type LiveExpectations,
  type LiveRpcState,
} from "./live-e2e-support.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SETTLE_GRACE_MS = 5_000;
const MAX_RPC_RECORD_BYTES = 8 * 1024 * 1024;

function duration(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

const SAFE_TOOL_NAMES = new Set([
  "send_email",
  "wait_for_replies",
  "inspect_agent",
  "manage_agent",
  "cancel_request",
  "fetch_emails",
]);
const SAFE_EXTENSION_EVENTS = new Set(["session_start", "session_switch", "session_shutdown"]);

function safeToolName(value: unknown): string {
  return typeof value === "string" && SAFE_TOOL_NAMES.has(value) ? value : "other";
}

function safeExtensionEvent(value: unknown): string {
  return typeof value === "string" && SAFE_EXTENSION_EVENTS.has(value) ? value : "extension_hook";
}

function addProtocolError(state: LiveRpcState, reason: string): void {
  if (!state.protocolErrors.includes(reason)) state.protocolErrors.push(reason);
}

function rpcSummary(event: Record<string, unknown>, state: LiveRpcState): Record<string, unknown> | undefined {
  if (event.type === "response" && (event.command === "get_state" || event.command === "prompt")) {
    return { type: "rpc_response", command: event.command, success: event.success === true };
  }
  if (event.type === "tool_execution_end") {
    const summary: Record<string, unknown> = {
      type: "tool_execution_end",
      toolName: safeToolName(event.toolName),
      isError: event.isError === true,
    };
    if (event.toolName === "send_email" && state.request) {
      summary.requestId = state.request.id;
      summary.provider = state.request.provider;
      summary.modelId = state.request.modelId;
    }
    if (event.toolName === "wait_for_replies" && state.reply) {
      summary.requestId = state.reply.requestId;
      summary.replyId = state.reply.id;
    }
    return summary;
  }
  if (event.type === "extension_error") {
    return { type: "extension_error", event: safeExtensionEvent(event.event) };
  }
  if (event.type === "agent_end") return { type: "agent_end", willRetry: event.willRetry === true };
  if (event.type === "agent_settled") return { type: "agent_settled" };
  return undefined;
}

class RpcDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private ended = false;

  constructor(private readonly accept: (event: Record<string, unknown>) => void) {}

  write(chunk: Buffer): void {
    if (this.ended) return;
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.consume(this.decoder.end());
    if (this.buffer.trim()) throw new Error("Pi RPC stdout ended with an unterminated JSONL record.");
    this.buffer = "";
  }

  private consume(decoded: string): void {
    this.buffer += decoded;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_RECORD_BYTES) {
      throw new Error("Pi RPC stdout record exceeded the live helper parsing bound.");
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error("Pi RPC stdout contained malformed JSONL.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Pi RPC stdout contained a non-object JSON record.");
        }
        this.accept(parsed as Record<string, unknown>);
      }
      newline = this.buffer.indexOf("\n");
    }
  }
}

async function main(): Promise<number> {
  const cliModel = process.env.LIVE_MODEL;
  const emailModel = process.env.LIVE_EMAIL_MODEL;
  if (!cliModel || !emailModel) {
    process.stderr.write("Set LIVE_MODEL (provider/model) and LIVE_EMAIL_MODEL (model ID).\n");
    return 2;
  }
  const separator = cliModel.indexOf("/");
  if (separator <= 0 || separator === cliModel.length - 1) {
    process.stderr.write("LIVE_MODEL must use the provider/model form.\n");
    return 2;
  }
  const provider = cliModel.slice(0, separator);
  const cliModelId = cliModel.slice(separator + 1);
  if (cliModelId !== emailModel) {
    process.stderr.write("LIVE_MODEL's model ID must exactly match LIVE_EMAIL_MODEL.\n");
    return 2;
  }

  let timeoutMs: number;
  let graceMs: number;
  try {
    timeoutMs = duration("LIVE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 30_000, 900_000);
    graceMs = duration("LIVE_SETTLE_GRACE_MS", DEFAULT_SETTLE_GRACE_MS, 250, 60_000);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid live duration configuration."}\n`);
    return 2;
  }

  const extraExtensions = (process.env.LIVE_EXTENSIONS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (value.includes("/") || value.includes("\\")) return value;
      const packageDir = join(homedir(), ".pi", "agent", "npm", "node_modules", value);
      const tsEntry = join(packageDir, "index.ts");
      if (existsSync(tsEntry)) return tsEntry;
      if (existsSync(packageDir)) return packageDir;
      return value;
    });
  const extensionArgs = extraExtensions.flatMap((extension) => ["-e", extension]);
  const expectations: LiveExpectations = {
    provider,
    modelId: emailModel,
    mainAddress: `main@${emailModel}.com`,
    recipientAddress: `scout.live-mail@${emailModel}.com`,
    subject: "Verify live mailbox",
  };
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const evidenceDir = resolve(process.env.LIVE_EVIDENCE_DIR ?? ".test-workspaces/live-e2e");
  const state = createLiveRpcState();
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let graceStarted = false;

  const child = spawn("pi", [
    "-ne",
    ...extensionArgs,
    "-e",
    "./src/index.ts",
    "--mode",
    "rpc",
    "--no-session",
    "--model",
    cliModel,
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const decoder = new RpcDecoder((event) => {
    reduceLiveRpcEvent(state, event, expectations);
    const summary = rpcSummary(event, state);
    if (summary) process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (readyForShutdownGrace(state) && !graceTimer && !graceStarted) {
      graceStarted = true;
      process.stdout.write(`${JSON.stringify({ type: "settlement_grace_started", graceMs })}\n`);
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        child.stdin.end();
      }, graceMs);
    }
  });

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      decoder.write(chunk);
    } catch {
      addProtocolError(state, "Pi RPC stdout failed canonical JSONL parsing");
      child.kill("SIGTERM");
    }
  });
  // Drain provider stderr without printing or retaining credential-bearing text.
  child.stderr.resume();
  child.stdin.on("error", () => {
    addProtocolError(state, "Pi RPC stdin failed before clean shutdown");
  });
  child.on("error", () => {
    addProtocolError(state, "Pi child process could not be started");
  });

  const hardTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);
  const close = new Promise<number | null>((resolveClose) => child.once("close", resolveClose));

  child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
  const prompt = [
    "Use send_email exactly once to delegate a tiny read-only task.",
    `Recipient: ${expectations.recipientAddress}`,
    `Subject: ${expectations.subject}`,
    "Message: Call fetch_emails, then reply with the exact names of the two virtual email tools available to you. Do not modify files.",
    "Priority: low",
    "After delegating, use the stable request ID with wait_for_replies and report the response.",
  ].join("\n");
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

  const childExitCode = await close;
  clearTimeout(hardTimer);
  if (graceTimer) clearTimeout(graceTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  try {
    decoder.end();
  } catch {
    addProtocolError(state, "Pi RPC stdout ended with incomplete canonical JSONL");
  }

  const sessionId = state.sessionIds.length === 1 ? state.sessionIds[0] : "unknown-live-session";
  const namespaceDir = join(agentDir, "subagents", sessionId!);
  const result = await finalizeLiveRun({
    state,
    expectations,
    namespaceDir,
    evidenceDir,
    childExitCode,
    timedOut,
  });
  const summary = {
    liveAcceptance: result.ok ? "passed" : "failed",
    childExitCode,
    evidence: result.evidencePath ? boundedEvidencePath(result.evidencePath) : undefined,
    namespace: result.removed ? "removed-after-validation" : result.preserved ? "preserved-for-investigation" : "missing",
    reasons: result.reasons,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch {
  // Do not echo provider/session exceptions: they can carry credentials. The
  // structured reducer/finalizer reports safe categorical failures in normal paths.
  process.stderr.write("Live helper failed before canonical evidence could be finalized.\n");
  process.exitCode = 1;
}
