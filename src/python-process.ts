import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { deadlineSignal } from "./runtime-timers.ts";
import { emailErrorDetails } from "./email-error.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { MAX_COMMANDS, PROGRESS_INTERVAL_MS, PROTOCOL_BYTES } from "./mechanistic.ts";
import { parseProgress, parseTerminal, protocolObject } from "./mechanistic-job.ts";
import type { EmailEnvelope, MechanisticJob, MechanisticProgress, MechanisticResult, SendEmailInput, SendEmailResult } from "./types.ts";

export const PYTHON_HELPER_DIR = fileURLToPath(new URL("./python/", import.meta.url));
export type PythonOutcome = Pick<MechanisticJob, "reported" | "result" | "exitCode" | "signal" | "stderr" | "cleanup" | "progress" | "pid">;
export interface PythonInvocation {
  envelope: EmailEnvelope;
  job: MechanisticJob;
  mainAddress: string;
  onSpawn: (pid: number) => Promise<void>;
  onProgress: (progress: MechanisticProgress) => Promise<void>;
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
}

/** One invocation, one exact direct child. No inbox or LLM transport methods. */
export class PythonProcess {
  private child?: ChildProcessWithoutNullStreams;
  private reason?: "protocol_failure" | "timeout" | "forced_stop";
  private stopping?: Promise<void>;
  private announceStop!: () => void;
  private readonly stopRequested = new Promise<void>((resolve) => { this.announceStop = resolve; });
  private settled?: Promise<PythonOutcome>;
  private childExited = false;
  private pipesClosed = false;
  private closeChild!: () => void;
  private readonly childClosed = new Promise<void>((resolve) => { this.closeChild = resolve; });

  constructor(private readonly invocation: PythonInvocation) {}

  stop(reason: "timeout" | "forced_stop" | "protocol_failure" = "forced_stop"): Promise<void> {
    this.reason ??= reason;
    this.stopping ??= this.terminate();
    this.announceStop();
    return this.stopping;
  }

  private async waitClose(ms: number): Promise<boolean> {
    const deadline = deadlineSignal(ms);
    try { return await Promise.race([this.childClosed.then(() => true), deadline.promise.then(() => false)]); }
    finally { deadline.cancel(); }
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Never signal a recycled PID: ChildProcess.kill owns this exact live child.
    if (!this.childExited) child.kill("SIGTERM");
    if (await this.waitClose(this.invocation.job.lifecycle.abortTimeoutMs)) return;
    if (!this.childExited) child.kill("SIGKILL");
    await this.waitClose(this.invocation.job.lifecycle.disposeTimeoutMs);
  }

  run(): Promise<PythonOutcome> {
    if (this.settled) return this.settled;
    this.settled = this.execute();
    return this.settled;
  }

  private async execute(): Promise<PythonOutcome> {
    const { job, envelope } = this.invocation;
    const initial = `${JSON.stringify({ v: 1, type: "invoke", jobId: job.id, mainAddress: this.invocation.mainAddress, envelope })}\n`;
    if (Buffer.byteLength(initial) > PROTOCOL_BYTES) throw new Error("Invocation exceeds protocol bound (admission must reject before acceptance).");
    if (this.reason) return { result: this.reason, stderr: "", cleanup: { state: "confirmed", childExited: true, pipesClosed: true, boundary: "direct-child-only" } };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(job.binding.python, ["-u", job.binding.script], {
        cwd: job.binding.cwd,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: `${PYTHON_HELPER_DIR}${delimiter}${process.env.PYTHONPATH ?? ""}` },
        stdio: ["pipe", "pipe", "pipe"], shell: false, detached: false,
      });
      this.child = child;
    } catch (error) {
      return { result: "spawn_failure", stderr: safeErrorSummary(error), cleanup: { state: "confirmed", childExited: true, pipesClosed: true, boundary: "direct-child-only" } };
    }
    let spawnError: string | undefined;
    let exitCode: number | null = null; let signal: string | null = null;
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0);
    let reported: MechanisticJob["reported"];
    let progress: MechanisticProgress | undefined;
    let lastProgressAt = 0; let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let progressWrite: Promise<void> = Promise.resolve();
    let progressWriting = false;
    let nextId = 1; let outstanding = 0; let ackBytes = 0;
    const commands = new Set<Promise<void>>();
    const protocolFailure = () => { void this.stop("protocol_failure"); };
    const publishProgress = () => {
      if (!progress || this.reason || progressWriting) return;
      lastProgressAt = Date.now();
      const latest = { ...progress };
      progressWriting = true;
      progressWrite = this.invocation.onProgress(latest).catch(() => { protocolFailure(); }).finally(() => { progressWriting = false; });
    };
    const acknowledge = (id: number, data: unknown) => {
      if (this.pipesClosed || child.stdin.destroyed) return;
      const line = `${JSON.stringify({ v: 1, type: "ack", id, ...protocolObject(data) })}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > PROTOCOL_BYTES || ackBytes + bytes > PROTOCOL_BYTES) { protocolFailure(); return; }
      ackBytes += bytes;
      child.stdin.write(line, () => { ackBytes -= bytes; });
    };
    const processFrame = (line: Buffer) => {
      let id: number | undefined;
      try {
        const raw = protocolObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (raw.v !== 1 || !Number.isInteger(raw.id) || raw.id !== nextId || nextId > 2_147_483_647
          || reported || this.reason || outstanding >= MAX_COMMANDS) throw new Error("Invalid, duplicate, excess, or post-terminal command.");
        id = raw.id as number; nextId += 1;
        const allowed = raw.op === "progress" ? ["v", "id", "op", "message", "percent"]
          : raw.op === "send_email" ? ["v", "id", "op", "to", "subject", "message", "priority"]
          : raw.op === "success" || raw.op === "failure" ? ["v", "id", "op", "summary", "artifacts", "invalidArguments"] : [];
        if (!allowed.length || Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Unknown protocol operation or field.");
        if (raw.op === "progress") {
          progress = parseProgress(raw);
          if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) publishProgress();
          else if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = undefined; publishProgress(); }, PROGRESS_INTERVAL_MS - (Date.now() - lastProgressAt));
          acknowledge(id, { ok: true });
          return;
        }
        if (raw.op === "success" || raw.op === "failure") {
          reported = parseTerminal({ ...raw, status: raw.op });
          acknowledge(id, { ok: true });
          return;
        }
        for (const key of ["to", "subject", "message"] as const) if (typeof raw[key] !== "string") throw new Error("Invalid mail fields.");
        if (raw.priority !== undefined && raw.priority !== "high" && raw.priority !== "low") throw new Error("Invalid mail priority.");
        outstanding += 1;
        const commandId = id;
        const command = this.invocation.sendEmail({ to: raw.to as string, subject: raw.subject as string, message: raw.message as string, priority: raw.priority as "low" | "high" ?? "low", requires_response: false }).then(
          (result) => acknowledge(commandId, { ok: true, accepted: true, mailId: result.envelope.id, deliveryState: result.envelope.deliveryState, deliveryUncertain: result.deliveryUncertain ?? null }),
          (error) => {
            const detail = emailErrorDetails(error);
            const mailId = detail.fields?.email_id;
            acknowledge(commandId, { ok: false, accepted: Boolean(mailId), ...(mailId ? { mailId, deliveryUncertain: true } : {}), error: safeErrorSummary(error) });
          },
        ).finally(() => { outstanding -= 1; commands.delete(command); });
        commands.add(command);
      } catch {
        if (id !== undefined) acknowledge(id, { ok: false, error: "protocol_failure" });
        protocolFailure();
      }
    };
    child.stdin.on("error", () => { if (!this.childExited) protocolFailure(); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.reason) return; // continue draining without retaining protocol after failure
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (stdout.length + segment.length + (newline < 0 ? 0 : 1) > PROTOCOL_BYTES) { protocolFailure(); stdout = Buffer.alloc(0); return; }
        stdout = Buffer.concat([stdout, segment]);
        if (newline < 0) break;
        processFrame(stdout); stdout = Buffer.alloc(0);
        if (this.reason) return;
        offset = newline + 1;
      }
    });
    child.stdout.on("end", () => { if (stdout.length) protocolFailure(); });
    child.stdout.on("error", protocolFailure);
    child.stderr.on("error", protocolFailure);
    child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-PROTOCOL_BYTES); });
    child.on("error", (error) => { spawnError = safeErrorSummary(error); this.childExited = true; });
    let pipeDeadline: ReturnType<typeof setTimeout> | undefined;
    child.on("exit", (code, sig) => {
      this.childExited = true; exitCode = code; signal = sig;
      // An exited child with inherited open pipes must not hold capacity until
      // the full run deadline. Unknown pipe cleanup is separate from its report.
      pipeDeadline = setTimeout(() => { void this.stop("forced_stop"); }, job.lifecycle.disposeTimeoutMs);
    });
    child.on("close", () => { this.childExited = true; this.pipesClosed = true; this.closeChild(); });
    const runDeadline = deadlineSignal(job.lifecycle.runTimeoutMs);
    const timeout = runDeadline.promise.then(async () => { await this.stop("timeout"); });
    const stopCompleted = this.stopRequested.then(() => this.stopping);
    try {
      if (child.pid) {
        try { await this.invocation.onSpawn(child.pid); child.stdin.write(initial); }
        catch { await this.stop("forced_stop"); }
      }
      await Promise.race([this.childClosed, timeout, stopCompleted]);
      // Send acceptance can outlive child exit. Never retry it or finalize before
      // bounded in-flight acknowledgments settle (the broker owns accepted mail).
      await Promise.race([Promise.allSettled([...commands]), timeout, this.stopping ?? new Promise<never>(() => {})]);
      if (this.stopping) await this.stopping;
    } finally {
      runDeadline.cancel();
      if (progressTimer) clearTimeout(progressTimer);
      if (pipeDeadline) clearTimeout(pipeDeadline);
      await progressWrite;
    }
    const cleanup = { state: this.childExited && this.pipesClosed ? "confirmed" as const : "cleanup-unknown" as const, childExited: this.childExited, pipesClosed: this.pipesClosed, boundary: "direct-child-only" as const };
    if (!this.pipesClosed) {
      // Closing our pipe endpoints bounds resources, not evidence: retain unknown.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
    const result: MechanisticResult = this.reason ?? (spawnError ? "spawn_failure" : exitCode !== 0 || signal ? "crash" : !reported ? "missing_terminal" : reported.invalidArguments ? "invalid_arguments" : reported.status === "failure" ? "task_failure" : "success");
    // Decode tail on character boundaries and keep its encoded size bounded.
    let tail = stderr.toString("utf8");
    while (Buffer.byteLength(tail) > PROTOCOL_BYTES) tail = tail.slice(1);
    return { result, ...(reported ? { reported } : {}), ...(progress ? { progress } : {}), ...(child.pid ? { pid: child.pid } : {}), exitCode, signal, stderr: spawnError ?? tail, cleanup };
  }
}
