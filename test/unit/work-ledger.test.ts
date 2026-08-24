import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePathConflicts, aggregateWork, appendRecent, beginBatch, capPatch, capText, classifyTool, countWrite, currentBatchHasEffectfulWork,
  displayWorkPath, emptyWorkState, finishWorkItem, MAX_COMMAND_CHARS, MAX_ERROR_CHARS, MAX_PATCH_BYTES,
  MAX_PATCH_LINES, MAX_RECENT_WORK, noteInspection, patchStats, recoverMutationWork, startWorkItem,
} from "../../src/work-ledger.ts";

describe("work ledger", () => {
  it("classifies tools without promoting shell or custom effects", () => {
    assert.deepEqual(["edit", "write", "bash", "read", "grep", "find", "ls", "send_email", "other"].map(classifyTool),
      ["edit", "write", "shell", "inspection", "inspection", "inspection", "inspection", "mailbox", "custom"]);
    const bash = startWorkItem("b", "bash", { command: "touch secret" }, 1, "/work")!;
    const custom = startWorkItem("c", "mystery", { path: "x" }, 1, "/work")!;
    assert.equal(bash.attribution, "unverified");
    assert.equal(custom.attribution, "unverified");
  });

  it("counts UTF-8 bytes and logical lines without retaining write content", () => {
    assert.deepEqual(["", "a", "a\n", "a\n\n", "a\r\nb", "🙂\n"].map((value) => countWrite(value).linesWritten), [0, 1, 1, 2, 2, 1]);
    const item = startWorkItem("w", "write", { path: "x.ts", content: "é🙂\nnext" }, 1, "/work")!;
    assert.equal(item.bytesWritten, Buffer.byteLength("é🙂\nnext"));
    assert.equal(item.linesWritten, 2);
    assert.equal(JSON.stringify(item).includes("next"), false);
    assert.deepEqual(countWrite(""), { bytesWritten: 0, linesWritten: 0 });
  });

  it("normalizes Pi path forms and canonicalizes symlink aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "work-path-"));
    try {
      await mkdir(join(root, "real")); await writeFile(join(root, "real", "a.ts"), "x"); await symlink(join(root, "real"), join(root, "alias"));
      const canonicalFile = await realpath(join(root, "real", "a.ts"));
      assert.deepEqual(displayWorkPath("@alias/a.ts", root), { path: canonicalFile, displayPath: "real/a.ts" });
      assert.deepEqual(displayWorkPath(`file://${join(root, "real", "a.ts")}`, root), { path: canonicalFile, displayPath: "real/a.ts" });
      await symlink(root, join(root, "workspace-alias"));
      assert.deepEqual(displayWorkPath("real/a.ts", join(root, "workspace-alias")), { path: canonicalFile, displayPath: "real/a.ts" });
      assert.equal(displayWorkPath("real\u00a0/a.ts", root).displayPath, "real /a.ts");
      assert.match(displayWorkPath("~/outside", root).displayPath!, /^\(absolute\)/);
      for (const unsafe of ["file:///tmp/%1B%5D0%3Bpwn%07x", "bad\nname", "bad\tname", "bad\u202ename"]) assert.deepEqual(displayWorkPath(unsafe, root), {});
      const unsafeIntent = startWorkItem("unsafe", "edit", { path: "file:///tmp/%1Bbad", edits: [] }, 1, root)!;
      assert.equal(unsafeIntent.path, undefined);
      const unknown = finishWorkItem(unsafeIntent, { details: { patch: "+x" } }, false);
      assert.equal(unknown.status, "unknown");
      assert.equal(unknown.attribution, "unverified");
      assert.equal(unknown.observedResult, "success");
      assert.equal(unknown.reasonCode, "unsafe-path");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("parses unified patch stats excluding headers and bounds previews/errors/commands", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more";
    assert.deepEqual(patchStats(patch), { linesAdded: 2, linesRemoved: 1 });
    assert.deepEqual(patchStats("--- a\r\n+++ b\r\n@@ -1,2 +1,2 @@\r\n---literal\r\n+++literal\r\n@@ -5 +5 @@\r\n-old\r\n+new"), { linesAdded: 2, linesRemoved: 2 });
    const huge = Array.from({ length: MAX_PATCH_LINES + 20 }, () => "+🙂".repeat(200)).join("\n");
    const capped = capPatch(huge);
    assert.ok(Buffer.byteLength(capped.patchPreview!, "utf8") <= MAX_PATCH_BYTES);
    assert.ok(capped.patchPreview!.split("\n").length <= MAX_PATCH_LINES);
    assert.equal(capped.patchTruncated, true);
    assert.ok(capText("x".repeat(1_000), MAX_COMMAND_CHARS)!.length <= MAX_COMMAND_CHARS);
    assert.ok(capText("x".repeat(1_000), MAX_ERROR_CHARS)!.length <= MAX_ERROR_CHARS);
  });

  it("handles malformed and overridden result shapes defensively", () => {
    const start = startWorkItem("e", "edit", { path: "x", edits: [{}] }, 1, "/work")!;
    const malformed = finishWorkItem(start, { details: { patch: 42, firstChangedLine: "x" } }, false);
    assert.equal(malformed.status, "succeeded");
    assert.equal(malformed.linesAdded, undefined);
    const failed = finishWorkItem(start, { content: [{ type: "image" }, { type: "text", text: "oldText not found\n\u001b[31mbad" }] }, true);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "edit failed");
    assert.doesNotMatch(JSON.stringify(failed), /oldText not found|bad/);
    const custom = startWorkItem("custom-error", "external_tool", { target: "service" }, 1, "/work")!;
    const customFailure = finishWorkItem(custom, {
      content: [{ type: "text", text: "Authorization: Bearer SENTINEL_WORK_LEDGER" }],
    }, true);
    assert.equal(customFailure.error, "Authorization: [redacted]");
    assert.doesNotMatch(JSON.stringify(customFailure), /SENTINEL/);
  });

  it("tracks batches, inspection, parallel completion order, failures and aggregate invariants", () => {
    const state = emptyWorkState();
    const batch = beginBatch(state, "2026-01-01T00:00:00.000Z");
    noteInspection(state.inspection, "read"); noteInspection(state.inspection, "grep"); noteInspection(state.inspection, "ls");
    const edit = startWorkItem("e", "edit", { path: "a", edits: [{ oldText: "a", newText: "b" }] }, batch, "/work", "2026-01-01T00:00:01.000Z")!;
    const write = startWorkItem("w", "write", { path: "b", content: "ok" }, batch, "/work", "2026-01-01T00:00:01.000Z")!;
    const bash = startWorkItem("b", "bash", { command: "touch c" }, batch, "/work")!;
    state.active.push(edit, write, bash);
    // Finish out of source order.
    appendRecent(state, finishWorkItem(write, {}, false));
    appendRecent(state, finishWorkItem(edit, { content: [{ type: "text", text: "no" }] }, true));
    appendRecent(state, finishWorkItem(bash, {}, false));
    state.active = [];
    assert.deepEqual(aggregateWork(state), { files: 1, linesAdded: 0, linesRemoved: 0, writes: 1, statsUnknown: false, unverified: 1 });
    assert.deepEqual(state.inspection, { reads: 1, searches: 1, listings: 1 });
    const next = beginBatch(state);
    assert.equal(next, 2);
    assert.deepEqual(state.inspection, { reads: 0, searches: 0, listings: 0 });
  });

  it("warns conservatively for any current-batch mutation, shell, or custom attempt only", () => {
    const state = emptyWorkState();
    beginBatch(state);
    assert.equal(currentBatchHasEffectfulWork(state), false);
    const prior = startWorkItem("prior", "bash", { command: "touch prior" }, 0, "/work")!;
    appendRecent(state, finishWorkItem(prior, {}, false));
    assert.equal(currentBatchHasEffectfulWork(state), false, "a prior batch does not contaminate the current warning");

    for (const [index, toolName] of ["edit", "write", "bash", "custom_effect"].entries()) {
      const item = startWorkItem(`current-${index}`, toolName, toolName === "edit"
        ? { path: "a.ts", edits: [] }
        : toolName === "write"
          ? { path: "a.ts", content: "x" }
          : toolName === "bash"
            ? { command: "touch a" }
            : { target: "external" }, state.currentBatchId!, "/work")!;
      state.active = [item];
      assert.equal(currentBatchHasEffectfulWork(state), true, `${toolName} running may have effects`);
      state.active = [];
      for (const status of ["succeeded", "failed", "interrupted"] as const) {
        appendRecent(state, { ...item, toolCallId: `${item.toolCallId}-${status}`, status });
        assert.equal(currentBatchHasEffectfulWork(state), true, `${toolName} ${status} may have effects`);
        state.recent = state.recent.filter((entry) => entry.batchId !== state.currentBatchId);
      }
    }
  });

  it("interrupts stale active entries, caps history and detects exact-path active conflicts", () => {
    const left = emptyWorkState(); const right = emptyWorkState();
    beginBatch(left); beginBatch(right);
    left.active.push(startWorkItem("l", "edit", { path: "same.ts", edits: [] }, 1, "/work")!);
    right.active.push(startWorkItem("r", "write", { path: "same.ts", content: "" }, 1, "/work")!);
    assert.equal(activePathConflicts([{ address: "l", work: left }, { address: "r", work: right }]).size, 1);
    beginBatch(left);
    assert.equal(left.recent.at(-1)?.status, "interrupted");
    for (let index = 0; index < MAX_RECENT_WORK + 10; index++) appendRecent(left, { ...left.recent[0]!, toolCallId: `x${index}` });
    assert.equal(left.recent.length, MAX_RECENT_WORK);
  });

  it("upserts durable terminal results over cached active/interrupted placeholders", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entries = [
      { type: "custom", id: "m", parentId: null, timestamp, customType: "pi-email-subagent-work-batch", data: { batchId: 4, startedAt: timestamp } },
      { type: "message", id: "a", parentId: "m", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }] } },
      { type: "message", id: "r", parentId: "a", timestamp, message: { role: "toolResult", toolCallId: "x", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { patch: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y" }, isError: false } },
    ];
    for (const cachedStatus of ["active", "interrupted"] as const) {
      const state = emptyWorkState(); state.currentBatchId = 4;
      const cached = startWorkItem("x", "edit", { path: "a.ts", edits: [] }, 4, "/work", timestamp)!;
      if (cachedStatus === "active") state.active.push(cached);
      else appendRecent(state, { ...cached, status: "interrupted", endedAt: timestamp });
      const recovered = recoverMutationWork(entries, "/work", state);
      const matches = recovered.recent.filter((item) => item.toolCallId === "x");
      assert.equal(matches.length, 1); assert.equal(matches[0]!.status, "succeeded"); assert.equal(matches[0]!.batchId, 4);
    }
    const failedEntries = structuredClone(entries); (failedEntries[2] as any).message.isError = true;
    const failed = recoverMutationWork(failedEntries, "/work");
    assert.equal(failed.recent.find((item) => item.toolCallId === "x")?.status, "failed");
  });

  it("keeps post-steer mutations in the durable marker batch", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const call = (id: string) => ({ type: "message", id: `a${id}`, parentId: null, timestamp: t, message: { role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path: `${id}.ts`, content: id } }] } });
    const result = (id: string) => ({ type: "message", id: `r${id}`, parentId: null, timestamp: t, message: { role: "toolResult", toolCallId: id, toolName: "write", content: [], isError: false } });
    const state = recoverMutationWork([
      { type: "custom", id: "m", parentId: null, timestamp: t, customType: "pi-email-subagent-work-batch", data: { batchId: 7, startedAt: t } },
      call("a"), result("a"),
      { type: "message", id: "steer", parentId: null, timestamp: t, message: { role: "user", content: "steer" } },
      call("b"), result("b"),
    ], "/work");
    assert.deepEqual(state.recent.map((item) => item.batchId), [7, 7]);
  });

  it("recovers durable mutation, shell, and custom terminal evidence without promoting unverified effects", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entries = [
      { type: "message", id: "a", parentId: null, timestamp, message: { role: "assistant", content: [
        { type: "toolCall", id: "e", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } },
        { type: "toolCall", id: "b", name: "bash", arguments: { command: "touch z" } },
      ] } },
      { type: "message", id: "r", parentId: "a", timestamp, message: { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { patch: "--- a\n+++ b\n-x\n+y" }, isError: false } },
      { type: "message", id: "br", parentId: "r", timestamp, message: { role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: "PRIVATE SHELL OUTPUT" }], isError: false } },
    ];
    const existing = emptyWorkState();
    appendRecent(existing, finishWorkItem(startWorkItem("e", "edit", { path: "a.ts", edits: [] }, 0, "/work")!, {}, false));
    const recovered = recoverMutationWork(entries, "/work", existing);
    assert.equal(recovered.effectEvidenceUnavailable, true, "markerless recovered effects must never be presented as complete evidence");
    assert.equal(recovered.recent.filter((item) => item.toolCallId === "e").length, 1);
    const bash = recovered.recent.find((item) => item.toolCallId === "b")!;
    assert.equal(bash.status, "succeeded");
    assert.equal(bash.attribution, "unverified");
    assert.equal(bash.observedResult, "success");
    assert.doesNotMatch(JSON.stringify(bash), /PRIVATE SHELL OUTPUT/);
  });

  it("recovers structurally unknown mutation outcomes and marks bounded missing effect evidence", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entries = [
      { type: "custom", id: "marker", parentId: null, timestamp, customType: "pi-email-subagent-work-batch", data: { batchId: 3, startedAt: timestamp } },
      { type: "message", id: "calls", parentId: "marker", timestamp, message: { role: "assistant", content: [
        { type: "toolCall", id: "mismatch", name: "edit", arguments: { path: "a.ts", edits: [] } },
        { type: "toolCall", id: "unsafe", name: "write", arguments: { path: "bad\npath", content: "PRIVATE BODY" } },
        { type: "toolCall", id: "custom", name: "external_effect", arguments: { target: "PRIVATE TARGET" } },
      ] } },
      { type: "message", id: "orphan", parentId: "calls", timestamp, message: { role: "toolResult", toolCallId: "orphan-edit", toolName: "edit", content: [{ type: "text", text: "PRIVATE RESULT" }], isError: false } },
      { type: "message", id: "mismatch-result", parentId: "orphan", timestamp, message: { role: "toolResult", toolCallId: "mismatch", toolName: "write", content: [], isError: false } },
      { type: "message", id: "unsafe-result", parentId: "mismatch-result", timestamp, message: { role: "toolResult", toolCallId: "unsafe", toolName: "write", content: [], isError: false } },
      { type: "message", id: "custom-result", parentId: "unsafe-result", timestamp, message: { role: "toolResult", toolCallId: "custom", toolName: "external_effect", content: [{ type: "text", text: "PRIVATE CUSTOM ERROR" }], isError: true } },
      { type: "message", id: "orphan-custom", parentId: "custom-result", timestamp, message: { role: "toolResult", toolCallId: "missing-custom-call", toolName: "other_effect", content: [], isError: false } },
    ];
    const recovered = recoverMutationWork(entries, "/work");
    assert.deepEqual(recovered.recent.filter((item) => item.status === "unknown").map((item) => ({
      id: item.toolCallId,
      observedResult: item.observedResult,
      reasonCode: item.reasonCode,
      attribution: item.attribution,
      path: item.path,
    })), [
      { id: "orphan-edit", observedResult: "success", reasonCode: "orphan-result", attribution: "unverified", path: undefined },
      { id: "mismatch", observedResult: "success", reasonCode: "mismatched-tool", attribution: "unverified", path: undefined },
      { id: "unsafe", observedResult: "success", reasonCode: "unsafe-path", attribution: "unverified", path: undefined },
      { id: "missing-custom-call", observedResult: "success", reasonCode: "orphan-result", attribution: "unverified", path: undefined },
    ]);
    const custom = recovered.recent.find((item) => item.toolCallId === "custom")!;
    assert.equal(custom.status, "failed");
    assert.equal(custom.attribution, "unverified");
    assert.equal(custom.observedResult, "error");
    assert.equal(recovered.effectEvidenceUnavailable, true);
    assert.equal(currentBatchHasEffectfulWork(recovered), true);
    assert.doesNotMatch(JSON.stringify(recovered), /PRIVATE|BODY|TARGET|RESULT|ERROR/);

    const truncated = recoverMutationWork([
      { type: "message", id: "old", parentId: null, timestamp, message: { role: "toolResult", toolCallId: "old-shell", toolName: "bash", content: [], isError: false } },
      ...Array.from({ length: 10_001 }, (_, index) => ({ type: "message", id: `filler-${index}`, parentId: null, timestamp, message: { role: "user", content: "filler" } })),
    ], "/work");
    assert.equal(truncated.effectEvidenceUnavailable, true);
    assert.equal(currentBatchHasEffectfulWork(truncated), true);
  });
});
