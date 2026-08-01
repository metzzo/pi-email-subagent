import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { awaitPromptAcceptance, effectiveWorkerModel, SdkWorker, terminalAgentError } from "../../src/sdk-worker.ts";
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

  it("uses the exact model object resolved by the worker runtime snapshot", () => {
    const parent = { provider: "custom", id: "model", baseUrl: "https://parent.invalid" } as never;
    const snapshot = { provider: "custom", id: "model", baseUrl: "https://worker.invalid" } as never;
    assert.equal(effectiveWorkerModel(parent, snapshot), snapshot);
    assert.equal(effectiveWorkerModel(parent), parent);
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
    assert.deepEqual(work.recent.map((item) => item.toolCallId), ["edit", "write", "orphan"]);
    assert.equal(work.recent[0]?.linesAdded, 1);
    assert.equal(work.recent[0]?.linesRemoved, 1);
    assert.equal(JSON.stringify(record).includes("TOP SECRET RAW"), false);
    assert.equal(JSON.stringify(record).includes("SECRET NEW"), false);

    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "mismatch", toolName: "edit", args: { path: "c", edits: [] } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "mismatch", toolName: "write", result: {}, isError: false });
    assert.equal(work.recent.find((item) => item.toolCallId === "mismatch")?.status, "failed");
    assert.match(record.activity.at(-1)?.summary ?? "", /failed/);
    internal.onSessionEvent({ type: "tool_execution_start", toolCallId: "pathless", toolName: "write", args: { path: "bad\nname", content: "SECRET" } });
    internal.onSessionEvent({ type: "tool_execution_end", toolCallId: "pathless", toolName: "write", result: {}, isError: false });
    assert.equal(work.recent.find((item) => item.toolCallId === "pathless")?.status, "failed");
    assert.match(record.activity.at(-1)?.summary ?? "", /failed/);
    assert.doesNotMatch(JSON.stringify(record), /SECRET/);
  });
});
