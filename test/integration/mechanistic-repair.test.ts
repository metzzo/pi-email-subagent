import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { emailErrorDetails } from "../../src/email-error.ts";
import { MailStore } from "../../src/mail-store.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import { CancelRequestSchema } from "../../src/tool-schemas.ts";
import type { MainAdapter, MechanisticJob } from "../../src/types.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error("Real repair evidence timed out"); await pause(10); }
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function fixture(code: string, maxConcurrent = 1) {
  const root = await mkdtemp(join(tmpdir(), "python-repair-"));
  const script = join(root, "job.py"); await writeFile(script, code);
  const config = structuredClone(DEFAULT_CONFIG);
  config.maxConcurrent = maxConcurrent;
  config.lifecycle = { ...config.lifecycle, runTimeoutMs: 6000, abortTimeoutMs: 80, disposeTimeoutMs: 80, brokerShutdownTimeoutMs: 400 };
  config.mechanisticPrograms = mergeMechanisticPrograms({}, { worker: { python: "python3", script, cwd: root } }, root);
  let idle = false;
  const mainAdapter: MainAdapter = { getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => idle,
    deliver: async ({ envelope }) => { await appendFile(join(root, "delivered"), envelope.id + "\n"); }, notifyFailure() {}, updateState() {} };
  const options = { cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], mainAdapter, projectTrusted: true, workerFactory: () => { throw new Error("No LLM expected"); } };
  let broker = new AgentBroker(options); await broker.init();
  return { root, config, options, get broker() { return broker; }, setIdle() { idle = true; },
    async reopen() { await broker.shutdown(); broker = new AgentBroker(options); await broker.init(); },
    async close() { await broker.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const send = (broker: AgentBroker, task = "test", message = "{}") => broker.send(broker.mainAddress, { to: `worker.${task}@mechanistic.com`, subject: "real repair", message, priority: "low" });
const settled = (broker: AgentBroker) => until(() => broker.getSnapshot().capacity.runSlotsUsed === 0);
const effect = "from pi_mechanistic import *\nfrom pathlib import Path\nimport time\na=arguments()\nwith open('effects','a') as f: f.write(invocation()['jobId']+'\\n')\nif a.get('hold'): time.sleep(5)\nsuccess('done')\n";

for (const cleanupUnknown of [true, false]) it(`queued abandonment preserves older identity failure and quarantine (cleanup unknown=${cleanupUnknown})`, { timeout: 15000 }, async () => {
  const f = await fixture("from pi_mechanistic import *\nimport subprocess,sys\nwith open('effects','a') as f: f.write(invocation()['jobId']+'\\n')\nif arguments().get('uncertain'):\n subprocess.Popen([sys.executable,'-c',\"import time; from pathlib import Path; time.sleep(.8); Path('descendant.done').touch()\"])\nsuccess('direct child done')\n");
  let watching = false;
  try {
    const first = await send(f.broker, "test", JSON.stringify({ uncertain: cleanupUnknown }));
    await until(() => f.broker.mailStore.getJob(first.envelope.id)?.phase === "terminal"); await settled(f.broker);
    if (!cleanupUnknown) await f.broker.clearFailure(first.envelope.to); // retains a prior cleanup audit timestamp
    const abandoned = await send(f.broker); const next = await send(f.broker);
    if (!cleanupUnknown) {
      const registered = f.config.mechanisticPrograms;
      f.config.mechanisticPrograms = {}; await f.reopen(); // actual missing-binding failure, no cleanup quarantine
      f.config.mechanisticPrograms = registered; // binding is usable, but failure still requires explicit restart
    }
    const identity = (snapshot = f.broker.getSnapshot()) => {
      const record = snapshot.agents.find((agent) => agent.address === first.envelope.to);
      assert.ok(record?.kind === "mechanistic");
      const { jobs: _jobs, ...state } = record; return state;
    };
    const before = identity(); const olderJob = f.broker.mailStore.getJob(first.envelope.id)!;
    assert.equal(before.state, "failed"); assert.equal(Boolean(before.cleanupUnknown), cleanupUnknown); assert.ok(before.failure);
    assert.equal(olderJob.cleanup?.state, cleanupUnknown ? "cleanup-unknown" : "confirmed");
    assert.equal(f.broker.mailStore.getJob(next.envelope.id)?.phase, "queued");
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 0, "durable quarantine releases the run slot, not the identity lease");
    const identitiesUsed = f.broker.getSnapshot().capacity.identitiesUsed;
    const publications: ReturnType<typeof identity>[] = [];
    f.options.mainAdapter.updateState = (snapshot) => { if (watching) publications.push(identity(snapshot)); };
    watching = true;
    await f.broker.cancelRequest(abandoned.envelope.id, "User abandons only this queued job, not the older uncertain work.");
    const immediatelyAfter = identity();
    // A subsequent accepted job must not accidentally unblock the earlier queued
    // job either. Unrelated real work proves the released run slot remains usable.
    const later = await send(f.broker);
    const unrelated = await send(f.broker, "unrelated");
    await until(() => f.broker.mailStore.getJob(unrelated.envelope.id)?.phase === "terminal"); await settled(f.broker);
    watching = false;
    const effects = await readFile(join(f.root, "effects"), "utf8");
    console.log(JSON.stringify({ cleanupUnknown, before, immediatelyAfter, nextPhase: f.broker.mailStore.getJob(next.envelope.id)?.phase, nextExecuted: effects.includes(next.envelope.id), laterExecuted: effects.includes(later.envelope.id) }));
    assert.deepEqual(immediatelyAfter, before, "abandonment cannot clear another job's identity failure or cleanup evidence");
    assert.deepEqual(identity(), before);
    assert.ok(publications.length > 0);
    for (const published of publications) assert.deepEqual(published, before, "no transient publication may reactivate the identity");
    assert.equal(f.broker.mailStore.getJob(next.envelope.id)?.phase, "queued");
    assert.equal(f.broker.mailStore.getJob(later.envelope.id)?.phase, "queued");
    assert.equal(effects.includes(next.envelope.id), false); assert.equal(effects.includes(abandoned.envelope.id), false);
    assert.equal(f.broker.mailStore.getJob(unrelated.envelope.id)?.result, "success");
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 0);
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, identitiesUsed + 1);
    const inspection = f.broker.inspectAgent(first.envelope.to);
    assert.equal(inspection.holdsActivationLease, true); assert.equal(inspection.state, "failed");
    const terminal = f.broker.mailStore.getJob(abandoned.envelope.id)!;
    assert.equal(terminal.result, "abandoned"); assert.equal(terminal.cleanup?.state, "confirmed");
    assert.equal(f.broker.mailStore.get(abandoned.envelope.id)?.deliveryState, "cancelled");
    assert.equal(f.broker.mailStore.list().filter((mail) => mail.id === terminal.outcomeMailId).length, 1);
    assert.deepEqual(f.broker.mailStore.getJob(first.envelope.id), olderJob);
    if (cleanupUnknown) await assert.rejects(f.broker.restart(first.envelope.to), /cleanup.*unknown/i);
    await f.broker.mailStore.compact(); await f.reopen();
    assert.equal(identity().state, "failed"); assert.equal(Boolean(identity().cleanupUnknown), cleanupUnknown);
    assert.equal(f.broker.mailStore.getJob(next.envelope.id)?.phase, "queued");
    assert.equal(f.broker.mailStore.getJob(abandoned.envelope.id)?.outcomeMailId, terminal.outcomeMailId);
    // Observe the deliberately finite inherited-pipe descendant settle before
    // the operator explicitly releases the historical identity quarantine.
    if (cleanupUnknown) await until(async () => (await readFile(join(f.root, "descendant.done")).catch(() => undefined)) !== undefined);
    await f.broker.clearFailure(first.envelope.to);
    assert.equal(identity().state, "stopped"); assert.equal(f.broker.mailStore.getJob(next.envelope.id)?.phase, "queued");
    await f.broker.restart(first.envelope.to);
    await until(() => f.broker.mailStore.getJob(later.envelope.id)?.phase === "terminal"); await settled(f.broker);
    assert.equal(f.broker.mailStore.getJob(next.envelope.id)?.result, "success");
    assert.equal(f.broker.mailStore.getJob(later.envelope.id)?.result, "success");
    assert.deepEqual(f.broker.mailStore.getJob(first.envelope.id), olderJob);
  } finally {
    watching = false;
    if (cleanupUnknown) await until(async () => (await readFile(join(f.root, "descendant.done")).catch(() => undefined)) !== undefined);
    await f.close();
  }
});

for (const removed of [false, true]) it(`abandons exactly one stopped queued Python job with durable audit and no process effect (binding removed=${removed})`, { timeout: 15000 }, async () => {
  const f = await fixture(effect);
  try {
    const first = await send(f.broker, "test", '{"hold":true}');
    await until(async () => (await readFile(join(f.root, "effects"), "utf8").catch(() => "")).includes(first.envelope.id));
    const abandoned = await send(f.broker); const next = await send(f.broker);
    await f.broker.stop(first.envelope.to);
    if (removed) { f.config.mechanisticPrograms = {}; await f.reopen(); }
    const reason = "User explicitly abandons this queued observation.\nNo replacement is requested.";
    const cancel = createMainCoordinationTools(async () => f.broker).find((tool) => tool.name === "cancel_request")!;
    assert.match(Reflect.get(CancelRequestSchema.properties.request_id, "description"), /accepted mail ID.*queued Python job/);
    assert.match(Reflect.get(CancelRequestSchema.properties.reason, "description"), /never-started queued Python job.*1024 UTF-8 bytes/);
    await cancel.execute("cancel", { request_id: abandoned.envelope.id, reason }, undefined, undefined, undefined as never);
    const job = f.broker.mailStore.getJob(abandoned.envelope.id)!;
    assert.equal(job.result, "abandoned"); assert.equal(job.generation, undefined); assert.equal(job.pid, undefined); assert.equal(job.reported, undefined);
    const trigger = f.broker.mailStore.get(job.id)!;
    assert.equal(trigger.deliveryState, "cancelled"); assert.equal(trigger.cancelledBy, f.broker.mainAddress); assert.equal(trigger.cancellationReason, reason);
    const outcome = f.broker.mailStore.get(job.outcomeMailId!)!;
    assert.equal(outcome.kind, "notification"); assert.equal(outcome.requiresResponse, false); assert.equal(outcome.inReplyTo, undefined);
    assert.equal(f.broker.mailStore.countPendingJobs(), 1);
    await assert.rejects(f.broker.cancelRequest(job.id, reason), /queued|terminal|claimed/);
    await f.broker.mailStore.compact(); await f.reopen();
    assert.equal(f.broker.mailStore.getJob(job.id)?.outcomeMailId, outcome.id);
    assert.equal(f.broker.mailStore.get(job.id)?.cancellationReason, reason);
    assert.equal(f.broker.mailStore.list().filter((mail) => mail.id === outcome.id).length, 1);
    if (removed) {
      await f.broker.cancelRequest(next.envelope.id, reason);
    } else {
      await f.broker.restart(first.envelope.to); await until(() => f.broker.mailStore.getJob(next.envelope.id)?.phase === "terminal"); await settled(f.broker);
    }
    assert.equal((await readFile(join(f.root, "effects"), "utf8")).includes(job.id), false);
    f.setIdle(); await f.broker.flushQueuedMainMail(); await f.broker.stop(first.envelope.to); await f.broker.archive(first.envelope.to);
    assert.equal(f.broker.inspectAgent(first.envelope.to).state, "archived");
    assert.equal(f.broker.mailStore.countPendingJobs(), 0);
  } finally { await f.close(); }
});

for (const phase of ["running", "progress", "terminal"] as const) it(`stop remains finite and holds authority during a stalled committed ${phase} callback`, { timeout: 15000 }, async () => {
  const f = await fixture(phase === "terminal" ? "from pi_mechanistic import success\nsuccess('done')\n" : "from pi_mechanistic import progress\nimport time\nprogress('committed')\ntime.sleep(5)\n");
  const held = gate(); let committed = false;
  const update = f.broker.mailStore.updateJob.bind(f.broker.mailStore);
  const save = f.broker.registryStore.save.bind(f.broker.registryStore);
  f.broker.mailStore.updateJob = async (job) => { await update(job); if (!committed && ((phase === "running" && job.phase === "running") || (phase === "progress" && job.progress))) { committed = true; await held.promise; } };
  // Hold committed finalization after its mail-serialization gate releases:
  // main can deliver the outcome while this exact Python run remains unsettled.
  f.broker.registryStore.save = async (registry) => {
    await save(registry);
    if (phase === "terminal" && !committed && f.broker.mailStore.listJobs().some((job) => job.phase === "terminal")) { committed = true; await held.promise; }
  };
  try {
    const accepted = await send(f.broker); await until(() => committed);
    const before = f.broker.mailStore.getJob(accepted.envelope.id)!; assert.ok(before.pid);
    const stop = f.broker.stop(accepted.envelope.to).then(() => "resolved", (error: unknown) => String(error));
    const result = await Promise.race([stop, pause(1000).then(() => "unbounded")]);
    assert.notEqual(result, "unbounded", "stop must not await a stalled post-commit callback indefinitely");
    assert.match(result, /LIFECYCLE_MECHANISTIC_SETTLEMENT_TIMEOUT/);
    assert.throws(() => process.kill(before.pid!, 0), /ESRCH/);
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 1);
    assert.equal(f.broker.mailStore.getJob(before.id)?.phase === "terminal", phase === "terminal");
    await assert.rejects(f.broker.restart(accepted.envelope.to), /Stop and settle/);
    // Even a committed outcome may already be delivered while its callback is
    // still held. Remove that independent mail blocker to test exact authority.
    f.setIdle(); await f.broker.flushQueuedMainMail();
    const blocked = f.broker.inspectAgent(accepted.envelope.to);
    const identitiesUsed = f.broker.getSnapshot().capacity.identitiesUsed;
    assert.equal(blocked.archiveBlockers.queued.count, 0);
    const archiveAttempt = await f.broker.archive(accepted.envelope.to).then(() => "archived", (error: unknown) => String(error));
    console.log(JSON.stringify({ phase, beforeArchive: blocked, archiveAttempt, afterArchive: f.broker.inspectAgent(accepted.envelope.to), capacity: f.broker.getSnapshot().capacity }));
    assert.equal(blocked.archiveEligible, false, "retained mechanistic settlement authority blocks archival even after stop and outcome delivery");
    assert.equal(blocked.archiveBlockers.active, true);
    assert.match(archiveAttempt, /cannot be archived.*active worker/i);
    assert.equal(f.broker.inspectAgent(accepted.envelope.to).holdsActivationLease, true);
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, identitiesUsed);
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 1);
    const rival = new AgentBroker(f.options); await assert.rejects(rival.init(), /owner|locked|ownership/i); await rival.shutdown().catch(() => undefined);
    held.release(); await stop; await until(() => f.broker.mailStore.getJob(before.id)?.phase === "terminal"); await settled(f.broker);
    const after = f.broker.mailStore.getJob(before.id)!;
    assert.equal(after.result, phase === "terminal" ? "success" : "forced_stop");
    if (phase === "terminal") assert.equal(after.outcomeMailId, before.outcomeMailId);
    const ready = f.broker.inspectAgent(accepted.envelope.to);
    assert.equal(ready.state, "stopped"); assert.equal(ready.archiveBlockers.active, false); assert.equal(ready.archiveEligible, true);
    assert.equal(ready.holdsActivationLease, true); assert.equal(ready.capacity.runSlotsUsed, 0);
    await f.broker.archive(accepted.envelope.to);
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, identitiesUsed - 1);
    await f.reopen();
    assert.equal(f.broker.inspectAgent(accepted.envelope.to).state, "archived");
    assert.equal(f.broker.mailStore.getJob(before.id)?.outcomeMailId, after.outcomeMailId);
    assert.equal(f.broker.mailStore.listJobs().length, 1);
  } finally { held.release(); await settled(f.broker); await f.close(); }
});

for (const recipient of ["python", "python-ack"] as const) it(`returns the stable uncertain mail ID after full-record append without delimiter and failed rollback (${recipient})`, { timeout: 15000 }, async () => {
  const f = await fixture("from pi_mechanistic import *\nfrom pathlib import Path\nimport json,time\nPath('ready').touch()\nwhile not Path('release').exists(): time.sleep(.01)\nack=send_email(invocation()['mainAddress'],'uncertain','Do not duplicate')\nPath('ack.json').write_text(json.dumps(ack))\nsuccess('done')\n");
  try {
    let id: string | undefined;
    if (recipient !== "python") { await send(f.broker); await until(async () => (await readFile(join(f.root, "ready")).catch(() => undefined)) !== undefined); }
    // The real descriptor accepts the complete record, then closes before the
    // append error: real EBADF proves rollback failure, without a fake journal.
    const seam = f.broker.mailStore as unknown as { appendJournalPayload(handle: FileHandle, payload: string): Promise<void> };
    seam.appendJournalPayload = async (handle, payload) => { const event = JSON.parse(payload.trim()); id = event.email.id; await handle.writeFile(payload.trimEnd()); await handle.close(); throw new Error("PRIVATE fs detail should not escape"); };
    let details;
    if (recipient === "python-ack") {
      await writeFile(join(f.root, "release"), ""); await until(async () => (await readFile(join(f.root, "ack.json")).catch(() => undefined)) !== undefined);
      const ack = JSON.parse(await readFile(join(f.root, "ack.json"), "utf8"));
      assert.equal(ack.ok, false); assert.equal(ack.accepted, true); assert.equal(ack.mailId, id); assert.equal(ack.deliveryUncertain, true);
      assert.match(ack.error, /Do not resend/); assert.doesNotMatch(ack.error, /PRIVATE|EBADF|truncate/);
    } else {
      try { await send(f.broker); assert.fail("append must fail"); }
      catch (error) { details = emailErrorDetails(error); }
      assert.equal(details!.code, "EMAIL_DELIVERY_FAILED", details!.message); assert.equal(details!.fields.email_id, id);
      assert.match(details!.message, /may have been accepted.*Do not resend/s); assert.doesNotMatch(details!.message, /PRIVATE|EBADF|truncate/);
    }
    assert.ok(id); assert.equal(f.broker.mailStore.get(id), undefined);
    if (recipient === "python") {
      await assert.rejects(send(f.broker, "not-accepted"), (error: unknown) => {
        assert.equal(emailErrorDetails(error).fields.email_id, undefined, "poison from the first append cannot label a later unattempted ID accepted");
        return true;
      });
    }
    const restored = new MailStore(f.broker.mailStore.path); await restored.init();
    assert.equal(restored.list().filter((mail) => mail.id === id).length, 1);
    assert.ok((await readFile(restored.path, "utf8")).endsWith("\n"));
    await restored.compact(); const again = new MailStore(restored.path); await again.init(); assert.equal(again.list().filter((mail) => mail.id === id).length, 1);
    if (recipient === "python") {
      await f.broker.shutdown().catch(() => undefined);
      await writeFile(join(f.root, "release"), "");
      const recovered = new AgentBroker(f.options); await recovered.init();
      try {
        await until(() => recovered.mailStore.getJob(id!)?.phase === "terminal"); await settled(recovered);
        assert.equal(recovered.mailStore.getJob(id!)?.result, "success");
        assert.equal(recovered.mailStore.listJobs().length, 1);
        assert.equal(recovered.mailStore.list().filter((mail) => mail.id === id).length, 1);
      } finally { await recovered.shutdown(); }
    }
  } finally { await f.broker.shutdown().catch(() => undefined); await rm(f.root, { recursive: true, force: true }); }
});

for (const winner of ["abandon", "claim"] as const) it(`serializes real abandonment versus restart with ${winner} winning`, { timeout: 15000 }, async () => {
  const f = await fixture(effect); const held = gate(); let committed = false;
  try {
    const original = await send(f.broker); await until(() => f.broker.mailStore.getJob(original.envelope.id)?.phase === "terminal"); await settled(f.broker);
    await f.broker.stop(original.envelope.to); const target = await send(f.broker);
    const reason = "User abandoned this precise queued scope.";
    if (winner === "abandon") {
      const finish = f.broker.mailStore.finishJob.bind(f.broker.mailStore);
      f.broker.mailStore.finishJob = async (job, mail) => { await finish(job, mail); committed = true; await held.promise; };
      const cancel = f.broker.cancelRequest(target.envelope.id, reason); await until(() => committed);
      const restart = f.broker.restart(target.envelope.to); held.release(); await cancel; await restart;
      assert.equal(f.broker.mailStore.getJob(target.envelope.id)?.result, "abandoned");
      assert.equal((await readFile(join(f.root, "effects"), "utf8")).includes(target.envelope.id), false);
    } else {
      const update = f.broker.mailStore.updateJob.bind(f.broker.mailStore);
      f.broker.mailStore.updateJob = async (job) => { await update(job); if (job.phase === "starting") { committed = true; await held.promise; } };
      const restart = f.broker.restart(target.envelope.to); await until(() => committed);
      const cancellation = assert.rejects(f.broker.cancelRequest(target.envelope.id, reason), /unclaimed queued/);
      held.release(); await restart; await cancellation;
      await until(() => f.broker.mailStore.getJob(target.envelope.id)?.phase === "terminal"); await settled(f.broker);
      assert.equal(f.broker.mailStore.getJob(target.envelope.id)?.result, "success");
      assert.equal((await readFile(join(f.root, "effects"), "utf8")).split(target.envelope.id).length, 2);
    }
  } finally { held.release(); await f.close(); }
});

it("rechecks queued abandonment atomically against a durable start claim and rejects active recipients", { timeout: 15000 }, async () => {
  const f = await fixture(effect); const held = gate(); let entered = false;
  try {
    const original = await send(f.broker, "test", '{"hold":true}');
    await until(async () => (await readFile(join(f.root, "effects"), "utf8").catch(() => "")).includes(original.envelope.id));
    const target = await send(f.broker);
    await assert.rejects(f.broker.cancelRequest(target.envelope.id, "User abandons this scope."), /inactive/);
    await f.broker.stop(original.envelope.to);
    const queued = f.broker.mailStore.getJob(target.envelope.id)!;
    const finish = f.broker.mailStore.finishJob.bind(f.broker.mailStore);
    f.broker.mailStore.finishJob = async (job, mail) => { entered = true; await held.promise; await finish(job, mail); };
    const cancellation = assert.rejects(f.broker.cancelRequest(target.envelope.id, "User abandons this scope."), /durable job transition/);
    await until(() => entered);
    // Exercise the journal's final serialized recheck independently of the
    // address gate: another committed start claim must not be overwritten.
    await f.broker.mailStore.updateJob({ ...queued, phase: "starting", generation: 99 });
    held.release(); await cancellation;
    assert.equal(f.broker.mailStore.getJob(target.envelope.id)?.phase, "starting");
    assert.equal(f.broker.mailStore.list().some((mail) => mail.subject.includes("abandoned")), false);
    await f.reopen(); assert.equal(f.broker.mailStore.getJob(target.envelope.id)?.result, "interrupted");
  } finally { held.release(); await f.close(); }
});
