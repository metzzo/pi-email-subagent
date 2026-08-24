import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { awaitPromptAcceptance, effectiveWorkerModel, SdkWorker, terminalAgentError } from "../../src/sdk-worker.ts";
import { processQuiescenceReceiptCapability } from "../../src/pi-compat.ts";
import { SAFE_SUMMARY_MAX_BYTES } from "../../src/safe-summary.ts";
import { emptyWorkState } from "../../src/work-ledger.ts";

const failedRun = [{
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "404 resource not found",
}] as unknown as AgentMessage[];

describe("SDK worker failures", () => {
  it("surfaces terminal model errors instead of treating them as successful settlement", () => {
    assert.equal(terminalAgentError(failedRun, false), "404 resource not found");
  });

  it("does not fail a worker while AgentSession will retry the request", () => {
    assert.equal(terminalAgentError(failedRun, true), undefined);
  });

  it("summarizes terminal native errors once before they enter worker events", () => {
    const native = [{
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: `Authorization: Bearer SENTINEL_NATIVE_BEARER\nhttps://user:SENTINEL_PASSWORD@example.invalid/path?sig=SENTINEL_SIGNATURE\n${"🙂".repeat(2_000)}`,
    }] as unknown as AgentMessage[];
    const summary = terminalAgentError(native, false);
    assert.ok(summary);
    assert.ok(Buffer.byteLength(summary, "utf8") <= SAFE_SUMMARY_MAX_BYTES);
    assert.doesNotMatch(summary, /SENTINEL|Bearer\s+\S+|user:/i);
  });

  it("maps Pi-managed retry lifecycle into bounded activity without a failure signal", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));

    internal.onSessionEvent({ type: "agent_end", messages: failedRun, willRetry: true });
    internal.onSessionEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4_000,
      errorMessage: "WebSocket error\nPRIVATE SUMMARY",
      headers: { authorization: "PRIVATE HEADER" },
      rawPayload: "PRIVATE PAYLOAD",
    });
    internal.onSessionEvent({ type: "auto_retry_end", success: true, attempt: 2 });

    assert.deepEqual(record.activity.map(({ kind, summary }: any) => ({ kind, summary })), [
      { kind: "status", summary: "Pi agent retry 2/3 scheduled in 4000ms: WebSocket error · PRIVATE SUMMARY" },
      { kind: "status", summary: "Pi agent retry recovered after attempt 2" },
    ]);
    assert.equal(events.some((event) => event.type === "failure"), false);
    assert.doesNotMatch(JSON.stringify(record.activity), /PRIVATE HEADER|PRIVATE PAYLOAD|authorization|rawPayload/);
  });

  it("sanitizes retry start/end detail before shared activity", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    internal.onSessionEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 5,
      errorMessage: "Authorization: Bearer SENTINEL_RETRY_START",
    });
    internal.onSessionEvent({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "https://example.invalid/path?signature=SENTINEL_RETRY_END",
    });
    assert.deepEqual(record.activity.map((item: any) => item.summary), [
      "Pi agent retry 1/2 scheduled in 5ms: Authorization: [redacted]",
      "Pi agent retry ended after attempt 1: https://example.invalid/path?signature=[redacted]",
    ]);
    assert.doesNotMatch(JSON.stringify(record.activity), /SENTINEL/);
  });

  it("records an unsuccessful retry end as activity while only the final non-retrying agent error fails once", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));

    internal.onSessionEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "fetch failed finally" });
    assert.equal(events.some((event) => event.type === "failure"), false);
    internal.onSessionEvent({ type: "agent_end", messages: failedRun, willRetry: false });
    internal.onSessionEvent({ type: "agent_settled" });

    assert.equal(events.filter((event) => event.type === "failure").length, 1);
    assert.equal(events.find((event) => event.type === "failure")?.error, "404 resource not found");
    assert.equal(record.state, "failed");
    assert.deepEqual(record.activity.map(({ kind, summary }: any) => ({ kind, summary })), [
      { kind: "error", summary: "Pi agent retry ended after attempt 3: fetch failed finally" },
      { kind: "error", summary: "404 resource not found" },
      { kind: "status", summary: "Agent run failed" },
    ]);
  });

  it("keeps retry activity within the existing 40-item and 500-character bounds", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    for (let attempt = 1; attempt <= 45; attempt += 1) {
      internal.onSessionEvent({
        type: "auto_retry_start",
        attempt,
        maxAttempts: 45,
        delayMs: attempt,
        errorMessage: `WebSocket error ${"x".repeat(1_000)}`,
      });
    }
    assert.equal(record.activity.length, 40);
    assert.ok(record.activity.every((item: any) => item.summary.length <= 500));
    assert.match(record.activity[0]?.summary ?? "", /retry 6\/45/);
  });

  it("uses the exact model object resolved by the worker runtime snapshot", () => {
    const parent = { provider: "custom", id: "model", baseUrl: "https://parent.invalid" } as never;
    const snapshot = { provider: "custom", id: "model", baseUrl: "https://worker.invalid" } as never;
    assert.equal(effectiveWorkerModel(parent, snapshot), snapshot);
    assert.equal(effectiveWorkerModel(parent), parent);
  });

  it("reuses one cleanup operation and reports active tool quiescence as unknown without a Pi receipt", async () => {
    const worker = new SdkWorker({} as never);
    let aborts = 0;
    let disposals = 0;
    let unsubscribes = 0;
    const session = {
      isStreaming: true,
      abort: async () => { aborts += 1; },
      dispose: () => { disposals += 1; },
    };
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as {
      session: typeof session;
      record: typeof record;
      cwd: string;
      unsubscribeSession: () => void;
      onSessionEvent(event: unknown): void;
    };
    internal.session = session;
    internal.record = record;
    internal.cwd = "/work";
    internal.unsubscribeSession = () => { unsubscribes += 1; };
    const observed: any[] = [];
    worker.subscribe((event) => observed.push(event));
    internal.onSessionEvent({
      type: "tool_execution_start",
      toolCallId: "bash-active",
      toolName: "bash",
      args: { command: "PRIVATE CLEANUP COMMAND" },
    });

    const first = (worker as any).cleanup({ abortTimeoutMs: 500 });
    const second = (worker as any).cleanup({ abortTimeoutMs: 500 });
    assert.equal(first, second, "repeated cleanup joins the exact same promise");
    const report = await first;
    assert.equal(aborts, 1);
    assert.equal(disposals, 1);
    assert.equal(unsubscribes, 1);
    assert.equal(report.sessionDisposed, true);
    assert.equal(report.providerQuiescent, true);
    assert.equal(report.quiescence, "unknown");
    assert.deepEqual(report.tools, [{
      toolCallId: "bash-active",
      toolName: "bash",
      quiescence: "unknown",
      detailCode: "PI_TOOL_QUIESCENCE_RECEIPT_UNAVAILABLE",
    }]);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|command|args|output/i);
    const before = observed.length;
    const recordBefore = structuredClone(record);
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "bash-active", toolName: "bash", result: {}, isError: false });
    assert.equal(observed.length, before, "cleanup suppresses all later worker events");
    assert.deepEqual(record, recordBefore, "cleanup also suppresses stale session mutation");
  });

  it("does not declare cleanup verified while the exact worker start operation is pending", async () => {
    const worker = new SdkWorker({} as never);
    let finishStart!: () => void;
    const startOperation = new Promise<void>((resolve) => { finishStart = resolve; });
    (worker as unknown as { startOperation: Promise<void> }).startOperation = startOperation;
    let settled = false;
    const cleanup = worker.cleanup({ abortTimeoutMs: 10 }).then((report) => {
      settled = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    finishStart();
    const report = await cleanup;
    assert.equal(report.quiescence, "verified");
  });

  it("attempts disposal at the abort deadline while keeping cleanup pending through a late successful abort", async () => {
    const worker = new SdkWorker({} as never);
    let releaseAbort!: () => void;
    const abortSettled = new Promise<void>((resolve) => { releaseAbort = resolve; });
    let disposed = false;
    const session = {
      isStreaming: true,
      abort: async () => { await abortSettled; },
      dispose: () => { disposed = true; },
    };
    const internal = worker as unknown as { session: typeof session };
    internal.session = session;

    let settled = false;
    const cleanup = worker.cleanup({ abortTimeoutMs: 10 }).then((report) => {
      settled = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, "the authoritative cleanup operation remains pending after the broker deadline");
    assert.equal(disposed, true, "disposal progresses once at the abort response deadline");

    releaseAbort();
    const report = await cleanup;
    assert.equal(report.abort, "succeeded");
    assert.equal(report.dispose, "succeeded");
    assert.equal(report.quiescence, "verified");
    assert.equal(disposed, true);
  });

  it("attempts dispose exactly once when abort never settles and repeated cleanup callers join", async () => {
    const worker = new SdkWorker({} as never);
    let aborts = 0;
    let disposals = 0;
    const session = {
      isStreaming: true,
      abort: async () => { aborts += 1; await new Promise<void>(() => undefined); },
      dispose: () => { disposals += 1; },
    };
    (worker as unknown as { session: typeof session }).session = session;
    const first = worker.cleanup({ abortTimeoutMs: 15 });
    const second = worker.cleanup({ abortTimeoutMs: 1 });
    assert.equal(first, second);
    let settled = false;
    void first.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(aborts, 1);
    assert.equal(disposals, 1);
    assert.equal(settled, false);
  });

  it("retains late abort rejection and dispose failure after deadline progression", async () => {
    const worker = new SdkWorker({} as never);
    let rejectAbort!: (error: Error) => void;
    const abort = new Promise<void>((_resolve, reject) => { rejectAbort = reject; });
    let disposals = 0;
    const session = {
      isStreaming: true,
      abort: async () => abort,
      dispose: () => { disposals += 1; throw new Error("dispose failed first"); },
    };
    (worker as unknown as { session: typeof session }).session = session;
    const cleanup = worker.cleanup({ abortTimeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disposals, 1);
    rejectAbort(new Error("late abort failed"));
    const report = await cleanup;
    assert.equal(report.abort, "failed");
    assert.equal(report.dispose, "failed");
    assert.equal(report.providerQuiescent, false);
    assert.equal(report.quiescence, "unknown");
    assert.match(report.detail ?? "", /abort failed|dispose failed/);
    assert.equal(disposals, 1);
  });

  it("disposes once after an abort settles just before its deadline", async () => {
    const worker = new SdkWorker({} as never);
    let aborts = 0;
    let disposals = 0;
    const session = {
      isStreaming: true,
      abort: async () => { aborts += 1; await new Promise((resolve) => setTimeout(resolve, 5)); },
      dispose: () => { disposals += 1; },
    };
    (worker as unknown as { session: typeof session }).session = session;
    const report = await worker.cleanup({ abortTimeoutMs: 50 });
    assert.equal(aborts, 1);
    assert.equal(disposals, 1);
    assert.equal(report.abort, "succeeded");
    assert.equal(report.dispose, "succeeded");
  });

  it("retains generation-level Bash process risk after the tool reports success", async () => {
    const worker = new SdkWorker({} as never);
    const session = { isStreaming: false, abort: async () => undefined, dispose: () => undefined };
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "idle" } as any;
    const internal = worker as unknown as { session: typeof session; record: typeof record; cwd: string; onSessionEvent(event: unknown): void };
    internal.session = session;
    internal.record = record;
    internal.cwd = "/work";
    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "completed-bash", toolName: "bash", args: { command: "PRIVATE" } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "completed-bash", toolName: "bash", result: {}, isError: false });

    const report = await worker.cleanup({ abortTimeoutMs: 10 });
    assert.deepEqual(report.tools, [], "completed tools are not mislabeled as active");
    assert.equal(report.quiescence, "unknown");
    assert.equal(report.source, processQuiescenceReceiptCapability().detailCode,
      "process-risk cleanup is tied to the explicit unsupported Pi capability gate");
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  });

  it("always unsubscribes and disposes a session when abort rejects", async () => {
    const worker = new SdkWorker({} as never);
    let unsubscribed = false;
    let sessionDisposed = false;
    const session = {
      isStreaming: true,
      abort: async () => { throw new Error("abort failed"); },
      dispose: () => { sessionDisposed = true; },
    };
    const internal = worker as unknown as {
      session: typeof session;
      unsubscribeSession: () => void;
      listeners: Set<unknown>;
    };
    internal.session = session;
    internal.unsubscribeSession = () => { unsubscribed = true; };
    internal.listeners.add(() => undefined);

    await assert.rejects(worker.dispose(), /abort failed/);
    assert.equal(unsubscribed, true);
    assert.equal(sessionDisposed, true);
    assert.equal(internal.listeners.size, 0);
    await assert.rejects(worker.dispose(), /abort failed/, "repeat disposal joins the same completed cleanup");
  });

  it("rejects promptly when AgentSession preflight rejects a prompt", async () => {
    await assert.rejects(
      awaitPromptAcceptance(async (preflight) => { preflight(false); }),
      /rejected during preflight/,
    );
  });

  it("rejects when a prompt completes without a preflight decision", async () => {
    await assert.rejects(awaitPromptAcceptance(async () => undefined), /without being accepted/);
  });

  it("starts batches only for independent deliveries, not enforcement prompts", async () => {
    const worker = new SdkWorker({} as never);
    const work = emptyWorkState();
    const session = { isIdle: true, prompt: async (_message: string, options: any) => { options.preflightResult(true); } };
    const markers: unknown[] = [];
    const internal = worker as unknown as { session: typeof session; sessionManager: { appendCustomEntry(type: string, data: unknown): void }; record: any };
    internal.session = session; internal.sessionManager = { appendCustomEntry: (_type, data) => { markers.push(data); } };
    internal.record = { work, activity: [], usage: {}, state: "idle" };
    await worker.prompt("delivery"); assert.equal(work.currentBatchId, 1);
    await worker.prompt("enforcement", { newBatch: false }); assert.equal(work.currentBatchId, 1);
    await worker.prompt("next delivery"); assert.equal(work.currentBatchId, 2);
    assert.equal(markers.length, 2);
  });

  it("keeps visible final assistant text in activity without attaching it to settlement", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "idle" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));
    internal.onSessionEvent({ type: "agent_start" });
    internal.onSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "Implemented the fix.\nTests pass." },
        ],
      },
    });
    internal.onSessionEvent({ type: "agent_settled" });
    const settled = [...events].reverse().find((event: any) => event.type === "settled");
    assert.deepEqual(settled, { type: "settled" });
    assert.equal(record.activity.some((item: any) => item.kind === "text" && item.summary === "Implemented the fix. Tests pass."), true);
    assert.doesNotMatch(JSON.stringify(events), /hidden reasoning/);
  });

  it("emits only content-free model and retry liveness facts", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; onSessionEvent(event: unknown): void };
    internal.record = record;
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));

    internal.onSessionEvent({ type: "agent_start", privatePrompt: "PRIVATE PROMPT" });
    internal.onSessionEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THINKING" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE DELTA" },
    });
    internal.onSessionEvent({ type: "agent_end", messages: [], willRetry: true, privateResponse: "PRIVATE RESPONSE" });
    internal.onSessionEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 4_000,
      errorMessage: "PRIVATE PROVIDER ERROR",
    });
    internal.onSessionEvent({ type: "auto_retry_end", success: true, attempt: 1, finalError: "PRIVATE FINAL ERROR" });

    const liveness = events.filter((event) => event.type === "run_liveness");
    assert.deepEqual(liveness, [
      { type: "run_liveness", phase: "model_start" },
      { type: "run_liveness", phase: "model_progress" },
      { type: "run_liveness", phase: "model_end" },
      { type: "run_liveness", phase: "retry_start", delayMs: 4_000 },
      { type: "run_liveness", phase: "retry_end" },
    ]);
    assert.doesNotMatch(JSON.stringify(liveness), /PRIVATE|prompt|thinking|delta|response|error/i);
  });

  it("emits only content-free lifecycle boundaries for tool starts and ends", () => {
    const worker = new SdkWorker({} as never);
    const record = { work: emptyWorkState(), activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; cwd: string; onSessionEvent(event: unknown): void };
    internal.record = record;
    internal.cwd = "/work";
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));

    internal.onSessionEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "PRIVATE START ARGUMENT" },
    });
    internal.onSessionEvent({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "PRIVATE UPDATE ARGUMENT" },
      partialResult: { content: [{ type: "text", text: "PRIVATE PARTIAL OUTPUT" }] },
    });
    internal.onSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "PRIVATE FINAL OUTPUT" }] },
      isError: false,
    });

    const lifecycle = events.filter((event) => event.type === "tool_lifecycle");
    assert.deepEqual(lifecycle.map(({ phase, toolCallId, toolName }) => ({ phase, toolCallId, toolName })), [
      { phase: "start", toolCallId: "call-1", toolName: "bash" },
      { phase: "end", toolCallId: "call-1", toolName: "bash" },
    ]);
    assert.ok(lifecycle.every((event) => !("at" in event)));
    assert.doesNotMatch(JSON.stringify(lifecycle), /PRIVATE|args|partialResult|result/);
  });

  it("correlates parallel tool calls by ID, handles orphan ends, and never stores mutation bodies in activity", () => {
    const worker = new SdkWorker({} as never);
    const work = emptyWorkState(); work.currentBatchId = 7;
    const record = { work, activity: [], usage: {}, state: "running" } as any;
    const internal = worker as unknown as { record: typeof record; cwd: string; onSessionEvent(event: unknown): void };
    internal.record = record; internal.cwd = "/work";
    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "a", content: "TOP SECRET RAW" } });
    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "b", edits: [{ oldText: "SECRET OLD", newText: "SECRET NEW" }] } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { details: { patch: "--- a\n+++ b\n-x\n+y" } }, isError: false });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "write", toolName: "write", result: {}, isError: false });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "orphan", toolName: "bash", result: {}, isError: false });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "orphan-edit", toolName: "edit", result: { private: "SECRET RESULT" }, isError: false });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "orphan-write-error", toolName: "write", result: { private: "SECRET ERROR" }, isError: true });
    assert.deepEqual(work.recent.map((item) => item.toolCallId), ["edit", "write", "orphan", "orphan-edit", "orphan-write-error"]);
    assert.equal(work.recent[0]?.linesAdded, 1);
    assert.equal(work.recent[0]?.linesRemoved, 1);
    const orphanEdit = work.recent.find((item) => item.toolCallId === "orphan-edit")!;
    assert.deepEqual({
      toolName: orphanEdit.toolName,
      kind: orphanEdit.kind,
      attribution: orphanEdit.attribution,
      status: orphanEdit.status,
      observedResult: orphanEdit.observedResult,
      reasonCode: orphanEdit.reasonCode,
      path: orphanEdit.path,
    }, {
      toolName: "edit",
      kind: "edit",
      attribution: "unverified",
      status: "unknown",
      observedResult: "success",
      reasonCode: "missing-start",
      path: undefined,
    });
    assert.equal(work.recent.find((item) => item.toolCallId === "orphan-write-error")?.status, "unknown");
    assert.equal(work.recent.find((item) => item.toolCallId === "orphan-write-error")?.observedResult, "error");
    assert.equal(JSON.stringify(record).includes("TOP SECRET RAW"), false);
    assert.equal(JSON.stringify(record).includes("SECRET NEW"), false);

    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "mismatch", toolName: "edit", args: { path: "c", edits: [] } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "mismatch", toolName: "write", result: {}, isError: false });
    assert.equal(work.recent.find((item) => item.toolCallId === "mismatch")?.status, "unknown");
    assert.equal(work.recent.find((item) => item.toolCallId === "mismatch")?.reasonCode, "mismatched-tool");
    assert.match(record.activity.at(-1)?.summary ?? "", /effect unknown\/unverified/);
    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "pathless", toolName: "write", args: { path: "bad\nname", content: "SECRET" } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "pathless", toolName: "write", result: {}, isError: false });
    assert.equal(work.recent.find((item) => item.toolCallId === "pathless")?.status, "unknown");
    assert.equal(work.recent.find((item) => item.toolCallId === "pathless")?.reasonCode, "unsafe-path");
    assert.match(record.activity.at(-1)?.summary ?? "", /effect unknown\/unverified/);
    assert.doesNotMatch(JSON.stringify(record), /SECRET/);
  });
});
