/**
 * Minimal JSON-lines RPC driver for a real `pi --mode rpc` process.
 *
 * Events are buffered; waitFor scans the buffer first so predicates match
 * events that arrived before the wait started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcLine {
  type: string;
  [key: string]: unknown;
}

export class JsonLineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private ended = false;

  constructor(private readonly onRecord: (record: RpcLine) => void) {}

  write(chunk: Buffer | string): void {
    if (this.ended) throw new Error("Pi RPC stdout arrived after the decoder was finalized.");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.consume(this.decoder.write(bytes));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.consume(this.decoder.end());
    if (this.buffer.trim()) {
      throw new Error("Unterminated Pi RPC stdout JSONL record at process close.");
    }
    this.buffer = "";
  }

  private consume(decoded: string): void {
    this.buffer += decoded;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const record = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (record.trim()) {
        let parsed: RpcLine;
        try {
          parsed = JSON.parse(record) as RpcLine;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Malformed Pi RPC stdout JSONL record: ${detail}`, { cause: error });
        }
        this.onRecord(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
  }
}

export interface LaunchOptions {
  cwd: string;
  agentDir: string;
  model: string;
  extensions: string[];
  piBin?: string;
  /** Keep the main session on disk (omit --no-session) so it can be resumed. */
  persistSession?: boolean;
  /** Resume one exact session from process startup. */
  session?: string;
  /** Additional deterministic child environment for local test providers. */
  env?: Record<string, string>;
}

export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly lines: RpcLine[] = [];
  private readonly waiters: {
    pred: (line: RpcLine) => boolean;
    after: number;
    resolve: (line: RpcLine) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  private readonly framer: JsonLineFramer;
  stderr = "";
  private exitCode: number | null | undefined;
  private readonly exitPromise: Promise<number | null>;
  private rejectExit!: (error: Error) => void;
  private terminalError?: Error;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.framer = new JsonLineFramer((line) => this.accept(line));
    this.exitPromise = new Promise((resolve, reject) => {
      this.rejectExit = reject;
      child.once("error", (error) => this.fail(error));
      child.once("close", (code) => {
        this.exitCode = code;
        try {
          this.framer.end();
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        if (this.terminalError) return;
        const error = new Error(`Pi exited with code ${code} before the expected event.\n${this.stderr}`);
        this.rejectWaiters(error);
        resolve(code);
      });
    });
    // Keep framing failures observable through waitFor/waitForExit/close without
    // creating a separate unhandled-rejection path before callers can await it.
    void this.exitPromise.catch(() => undefined);
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.framer.write(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        child.kill("SIGTERM");
      }
    });
    child.stderr!.on("data", (chunk) => { this.stderr += String(chunk); });
  }

  static launch(options: LaunchOptions): PiRpcClient {
    const args = ["-ne"];
    for (const extension of options.extensions) args.push("-e", extension);
    args.push("--mode", "rpc");
    if (!options.persistSession) args.push("--no-session");
    if (options.session) args.push("--session", options.session);
    args.push("--model", options.model);
    const child = spawn(options.piBin ?? process.env.PI_BIN ?? "pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, PI_CODING_AGENT_DIR: options.agentDir },
    });
    return new PiRpcClient(child);
  }

  private accept(line: RpcLine): void {
    this.lines.push(line);
    for (const waiter of [...this.waiters]) {
      if (this.lines.length - 1 < waiter.after) continue;
      if (!waiter.pred(line)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectWaiters(error);
    this.rejectExit(error);
  }

  /** Current buffer length; pass to waitFor via `after` to only match future events. */
  mark(): number {
    return this.lines.length;
  }

  events(): readonly RpcLine[] {
    return this.lines;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    return this.child.kill(signal);
  }

  waitForExit(): Promise<number | null> {
    return this.exitPromise;
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(command)}\n`);
  }

  async prompt(message: string): Promise<void> {
    const mark = this.mark();
    this.send({ type: "prompt", message });
    await this.waitFor(
      (line) => line.type === "response" && line.command === "prompt",
      "prompt preflight response",
      30_000,
      mark,
    );
  }

  async setModel(provider: string, modelId: string): Promise<RpcLine> {
    const mark = this.mark();
    this.send({ type: "set_model", provider, modelId });
    return this.waitFor(
      (line) => line.type === "response" && line.command === "set_model",
      "set_model response",
      30_000,
      mark,
    );
  }

  async getState(): Promise<RpcLine> {
    const mark = this.mark();
    this.send({ type: "get_state" });
    return this.waitFor(
      (line) => line.type === "response" && line.command === "get_state",
      "get_state response",
      30_000,
      mark,
    );
  }

  async switchSession(sessionPath: string): Promise<RpcLine> {
    const mark = this.mark();
    this.send({ type: "switch_session", sessionPath });
    return this.waitFor(
      (line) => line.type === "response" && line.command === "switch_session" && line.success === true,
      "switch_session response",
      30_000,
      mark,
    );
  }

  /** Poll buffered events until `count` matching lines exist after `mark`. */
  async collect(
    pred: (line: RpcLine) => boolean,
    count: number,
    description: string,
    timeoutMs = 90_000,
    after = 0,
  ): Promise<RpcLine[]> {
    if (this.terminalError) throw this.terminalError;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.terminalError) throw this.terminalError;
      const matches = this.lines.slice(Math.max(after, 0)).filter(pred);
      if (matches.length >= count) return matches;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    }
    throw new Error(`Timed out collecting ${count} × ${description}.\n${this.stderr}\nLast events: ${this.tailSummary()}`);
  }

  waitFor(
    pred: (line: RpcLine) => boolean,
    description: string,
    timeoutMs = 90_000,
    after = 0,
  ): Promise<RpcLine> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    for (let index = Math.max(after, 0); index < this.lines.length; index += 1) {
      if (pred(this.lines[index]!)) return Promise.resolve(this.lines[index]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.findIndex((w) => w.timer === timer), 1);
        reject(new Error(`Timed out waiting for ${description}.\n${this.stderr}\nLast events: ${this.tailSummary()}`));
      }, timeoutMs);
      this.waiters.push({ pred, after, resolve, reject, timer });
    });
  }

  private tailSummary(): string {
    return this.lines.slice(-12).map((line) => {
      const extra = line.toolName ?? (line.message as { role?: string } | undefined)?.role ?? line.command ?? "";
      return `${line.type}${extra ? `:${String(extra)}` : ""}`;
    }).join(", ");
  }

  /** Wait for the next main-session agent_settled emitted after `after`. */
  async waitForSettlement(after: number, timeoutMs = 90_000): Promise<RpcLine> {
    return this.waitFor((line) => line.type === "agent_settled", "main agent_settled", timeoutMs, after);
  }

  async close(): Promise<number | null> {
    if (this.exitCode !== undefined && this.exitCode !== null) return this.exitPromise;
    this.child.stdin!.end();
    const timeout = setTimeout(() => this.child.kill("SIGTERM"), 20_000);
    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(timeout);
    }
  }
}
