/**
 * Minimal JSON-lines RPC driver for a real `pi --mode rpc` process.
 *
 * Events are buffered; waitFor scans the buffer first so predicates match
 * events that arrived before the wait started.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RpcLine {
  type: string;
  [key: string]: unknown;
}

export interface LaunchOptions {
  cwd: string;
  agentDir: string;
  model: string;
  extensions: string[];
  piBin?: string;
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
  private buffer = "";
  stderr = "";
  private exitCode: number | null | undefined;
  private readonly exitPromise: Promise<number | null>;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.on("data", (chunk) => this.ingest(String(chunk)));
    child.stderr!.on("data", (chunk) => { this.stderr += String(chunk); });
    this.exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        this.exitCode = code;
        const error = new Error(`Pi exited with code ${code} before the expected event.\n${this.stderr}`);
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        resolve(code);
      });
    });
  }

  static launch(options: LaunchOptions): PiRpcClient {
    const args = ["-ne"];
    for (const extension of options.extensions) args.push("-e", extension);
    args.push("--mode", "rpc", "--no-session", "--model", options.model);
    const child = spawn(options.piBin ?? process.env.PI_BIN ?? "pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
    });
    return new PiRpcClient(child);
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      let line: RpcLine;
      try {
        line = JSON.parse(part) as RpcLine;
      } catch {
        continue; // ignore non-JSON noise
      }
      this.lines.push(line);
      for (const waiter of [...this.waiters]) {
        if (this.lines.length - 1 < waiter.after) continue;
        if (!waiter.pred(line)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  }

  /** Current buffer length; pass to waitFor via `after` to only match future events. */
  mark(): number {
    return this.lines.length;
  }

  events(): readonly RpcLine[] {
    return this.lines;
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(command)}\n`);
  }

  async prompt(message: string): Promise<void> {
    this.send({ type: "prompt", message });
    await this.waitFor(
      (line) => line.type === "response" && line.command === "prompt",
      "prompt preflight response",
      30_000,
    );
  }

  async getState(): Promise<RpcLine> {
    this.send({ type: "get_state" });
    return this.waitFor(
      (line) => line.type === "response" && line.command === "get_state",
      "get_state response",
      30_000,
    );
  }

  waitFor(
    pred: (line: RpcLine) => boolean,
    description: string,
    timeoutMs = 90_000,
    after = 0,
  ): Promise<RpcLine> {
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
