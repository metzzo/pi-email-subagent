import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { assertUnreservedModel, isMechanisticAddress, mergeMechanisticPrograms, parseMechanisticBinding, parseMechanisticCallers, preflightMechanisticBinding, sameMechanisticBinding } from "../../src/mechanistic.ts";
import { boundedProtocolString, outcomeText, parseJob, parseProgress, parseTerminal, protocolObject } from "../../src/mechanistic-job.ts";
import { transitionAbandonedOwnerRecovery } from "../../src/abandoned-owner-recovery.ts";
import { aggregateWork, emptyWorkState, extractError, finishWorkItem, startWorkItem } from "../../src/work-ledger.ts";
import { errorMessage } from "../../src/util.ts";
import { NamespaceLock } from "../../src/namespace-lock.ts";
import type { LlmAgentRecord, MechanisticJob } from "../../src/types.ts";

/** Identical parser contracts run through both supported real module loaders. */
export async function mechanisticParserCases(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "python-parser-contract-"));
  try {
    await assert.rejects(NamespaceLock.acquire(join(root, "invalid\nnamespace"), () => {}), /namespace path is invalid/);
    const script = join(root, "job.py"); await writeFile(script, "raise RuntimeError('preflight must not execute')\n");
    const program = mergeMechanisticPrograms({}, { worker: { python: "python3", script, cwd: root } }, root).worker!;
    assert.deepEqual(program.allowedCallers, ["main"]);
    const binding = parseMechanisticBinding(program);
    for (const value of [null, [], false, "object"]) {
      assert.throws(() => protocolObject(value)); assert.throws(() => parseMechanisticBinding(value));
      assert.throws(() => mergeMechanisticPrograms({}, value, root));
    }
    assert.deepEqual(protocolObject({}), {});
    for (const value of [undefined, null, 1, "", "  ", "x".repeat(4097), "bad\u0000", "bad\u202e"]) assert.throws(() => parseMechanisticBinding({ ...binding, script: value }));
    for (const value of [undefined, 1, "", "Upper", "bad.key", "x".repeat(49)]) assert.throws(() => parseMechanisticBinding({ ...binding, key: value }));
    for (const key of ["python", "script", "cwd"]) assert.throws(() => parseMechanisticBinding({ ...binding, [key]: "relative" }));
    assert.equal(sameMechanisticBinding(binding, { ...binding }), true);
    for (const key of ["key", "python", "script", "cwd"] as const) assert.equal(sameMechanisticBinding(binding, { ...binding, [key]: `${binding[key]}-other` }), false);
    assert.equal(mergeMechanisticPrograms({}, undefined, root).worker, undefined);
    assert.throws(() => mergeMechanisticPrograms({}, { "bad.key": {} }, root));
    assert.throws(() => mergeMechanisticPrograms({ worker: program }, { WORKER: {} }, root));
    assert.throws(() => mergeMechanisticPrograms({}, { worker: { ...binding, unknown: true } }, root));
    assert.throws(() => mergeMechanisticPrograms({}, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key-${i}`, {}])), root));
    const relativePython = join(root, "python"); await symlink(program.python, relativePython);
    assert.equal(mergeMechanisticPrograms({}, { worker: { python: "./python", script: "job.py" } }, root).worker!.python, program.python);
    const oldPath = process.env.PATH;
    try {
      const first = join(root, "first"); const second = join(root, "second"); await mkdir(first); await mkdir(second);
      await mkdir(join(first, "python-contract")); await symlink(program.python, join(second, "python-contract"));
      process.env.PATH = `${first}:${second}`;
      assert.equal(mergeMechanisticPrograms({}, { worker: { python: "python-contract", script } }, root).worker!.python, program.python);
      await writeFile(join(first, "not-executable"), "no execution"); await chmod(join(first, "not-executable"), 0o600);
      assert.throws(() => mergeMechanisticPrograms({}, { worker: { python: "not-executable", script } }, root), /not found/);
      delete process.env.PATH;
      assert.throws(() => mergeMechanisticPrograms({}, { worker: { python: "missing-executable", script } }, root), /not found/);
    } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    assert.throws(() => preflightMechanisticBinding({ ...binding, python: root }), /must be a file/);
    assert.throws(() => preflightMechanisticBinding({ ...binding, script: root }), /readable file/);
    await chmod(script, 0o700);
    assert.throws(() => preflightMechanisticBinding({ ...binding, cwd: script }), /directory/);
    assert.throws(() => preflightMechanisticBinding({ ...binding, script: join(root, "absent") }), /ENOENT/);
    assertUnreservedModel("normal"); assert.throws(() => assertUnreservedModel(" MECHANISTIC "), /reserved/);
    assert.equal(isMechanisticAddress(" worker.x@MeChanistic.com "), true); assert.equal(isMechanisticAddress("worker.x@normal.com"), false);
    for (const value of [null, "main", [], ["main", "main"], ["unknown"], ["main", "llm", "mechanistic", "main"]]) assert.throws(() => parseMechanisticCallers(value));
    assert.deepEqual(parseMechanisticCallers(["main", "llm", "mechanistic"]), ["main", "llm", "mechanistic"]);
    for (const value of [null, 1, "", " ", "x".repeat(4097)]) assert.throws(() => boundedProtocolString(value, 4096));
    assert.equal(boundedProtocolString("valid", 4096), "valid");
    assert.deepEqual(parseProgress({ message: "tick" }), { message: "tick" });
    assert.deepEqual(parseProgress({ message: "tick", percent: 0 }), { message: "tick", percent: 0 });
    assert.equal(parseProgress({ message: "tick", percent: 100 }).percent, 100);
    for (const percent of [null, false, "1", NaN, Infinity, -1, 101]) assert.throws(() => parseProgress({ message: "tick", percent }));
    assert.deepEqual(parseTerminal({ status: "success", summary: "done" }).artifacts, []);
    assert.equal(parseTerminal({ status: "failure", summary: "invalid", invalidArguments: true }).invalidArguments, true);
    for (const fields of [{ status: "other" }, { invalidArguments: false }, { invalidArguments: true }, { artifacts: "bad" }, { artifacts: Array(33).fill("x") }, { artifacts: [""] }, { artifacts: ["x".repeat(2049)] }]) assert.throws(() => parseTerminal({ status: "success", summary: "done", ...fields }));
    const at = new Date().toISOString();
    const job: MechanisticJob = { id: "mail_contract", address: "worker.contract@mechanistic.com", binding, allowedCallers: ["main"], lifecycle: { ...DEFAULT_CONFIG.lifecycle }, phase: "queued", createdAt: at, updatedAt: at, stderr: "" };
    assert.deepEqual(parseJob(job), job);
    const fields: Record<string, unknown>[] = [
      { phase: "bad" }, { address: "worker.contract@model.com" }, { address: "other.contract@mechanistic.com" },
      { lifecycle: { ...job.lifecycle, runTimeoutMs: 0 } }, { lifecycle: { ...job.lifecycle, runTimeoutMs: Infinity } },
      { stderr: 1 }, { stderr: "x".repeat(65537) }, { createdAt: "bad" }, { updatedAt: "bad" },
      { generation: 0 }, { pid: 1.2 }, { result: "invalid-result" }, { exitCode: -1 }, { signal: 1 },
      { cleanup: null }, { cleanup: { state: "bad" } }, { cleanup: { state: "confirmed", boundary: "direct-child-only", childExited: false, pipesClosed: true } },
      { cleanup: { state: "cleanup-unknown", boundary: "wrong", childExited: true, pipesClosed: true } },
      { cleanup: { state: "cleanup-unknown", boundary: "direct-child-only", childExited: "yes", pipesClosed: true } },
      { cleanup: { state: "cleanup-unknown", boundary: "direct-child-only", childExited: true, pipesClosed: "yes" } },
      { phase: "terminal" }, { phase: "running" }, { generation: 1 }, { pid: 1 }, { result: "success" }, { outcomeMailId: "mail_outcome" },
    ];
    for (const field of fields) assert.throws(() => parseJob({ ...job, ...field }), JSON.stringify(field));
    const terminal = parseJob({ ...job, phase: "terminal", generation: 1, pid: process.pid, exitCode: 0, signal: null, result: "success", outcomeMailId: "mail_outcome", progress: { message: "finished", percent: 100 }, reported: { status: "success", summary: "done", artifacts: [script] }, cleanup: { state: "confirmed", boundary: "direct-child-only", childExited: true, pipesClosed: true } });
    assert.match(outcomeText(terminal), /Artifact references \(not verified\)/);
    assert.match(outcomeText(job), /Script report: none/);
    assert.equal(parseJob({ ...terminal, exitCode: null, signal: "SIGKILL", cleanup: { state: "cleanup-unknown", childExited: true, pipesClosed: false, boundary: "direct-child-only", detail: "pipe still open" } }).signal, "SIGKILL");
    const old: LlmAgentRecord = { kind: "llm", address: "worker.old@model.com", name: "worker", taskSlug: "old", provider: "provider", modelId: "model", effort: "medium", tools: ["bash"], state: "running", createdAt: at, updatedAt: at, enforcementAttempts: 0, lifecycle: { ...DEFAULT_CONFIG.lifecycle }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, activity: [], workerEpoch: { generation: 1, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: true } };
    const recovered = transitionAbandonedOwnerRecovery(old);
    assert.equal(recovered.record.state, "failed"); assert.match(recovered.record.failure!, /exact prior broker owner died/i); assert.equal(old.state, "running");
    for (const state of ["running", "idle", "stopped", "archived"] as const) {
      for (const phase of [undefined, "spawning", "activated", "session-settled"] as const) {
        const record = { ...structuredClone(old), state, workerEpoch: phase ? { ...old.workerEpoch!, phase } : undefined };
        const result = transitionAbandonedOwnerRecovery(record);
        const changed = phase === "spawning" || phase === "activated" || (phase === undefined && state !== "stopped" && state !== "archived");
        assert.equal(result.changed, changed); if (!changed) assert.deepEqual(result.record, record);
      }
    }
    const cleanup: NonNullable<LlmAgentRecord["cleanup"]> = { state: "pending", reasonCode: "LIFECYCLE_RUN_TIMEOUT", workerGeneration: 1, startedAt: at, updatedAt: at, abort: "succeeded", dispose: "succeeded", quiescence: "unknown", mutationCapableAtStart: true, heldRunSlot: false, activeTools: [] };
    for (const change of [{}, { abort: "pending" }, { dispose: "pending" }, { activeTools: [{ toolCallId: "tool", toolName: "bash" }] }, { heldRunSlot: true }] as const) {
      const record = { ...structuredClone(old), cleanup: { ...cleanup, ...change } } as LlmAgentRecord;
      const result = transitionAbandonedOwnerRecovery(record);
      assert.equal(result.record.cleanup, undefined); assert.equal(result.record.workerEpoch!.phase, "session-settled");
      assert.match(result.record.failure!, Object.keys(change).length === 0 ? /Historical cleanup/ : /exact prior broker owner died/);
    }
    for (const epoch of [undefined, { ...old.workerEpoch!, generation: 2 }, { ...old.workerEpoch!, phase: "session-settled" as const }]) {
      const result = transitionAbandonedOwnerRecovery({ ...structuredClone(old), workerEpoch: epoch, cleanup });
      assert.equal(result.record.cleanup!.state, "unknown"); assert.equal(result.record.cleanup!.heldRunSlot, false); assert.match(result.record.failure!, /structurally ambiguous/);
    }
    assert.equal(errorMessage(new Error("contract error")), "contract error"); assert.equal(errorMessage("plain error"), "plain error");
    assert.match(extractError({ content: [{ type: "text", text: "failed" }] })!, /failed/);
    const state = emptyWorkState(); state.currentBatchId = 1;
    state.recent.push(finishWorkItem(startWorkItem("contract-write", "write", { path: script, content: "text" }, 1, root)!, {}, false));
    assert.equal(aggregateWork(state).writes, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
}
