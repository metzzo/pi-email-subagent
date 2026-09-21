import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DashboardComponent } from "../../src/ui.ts";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { parseMailEvent } from "../../src/mail-store.ts";
import { parseJob } from "../../src/mechanistic-job.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import { mainCoordinatorPrompt } from "../../src/prompts.ts";
import { createWorkerMailTools, type SendToolDetails } from "../../src/sdk-worker.ts";
import type { MainAdapter, MainDelivery } from "../../src/types.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000) { const end = Date.now() + ms; while (!await check()) { if (Date.now() >= end) throw new Error("Python UX evidence timed out"); await pause(10); } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "python-ux-"));
  const script = join(root, "observe.py");
  await writeFile(script, "from pi_mechanistic import *\nimport time\ndef main(args):\n progress('observing',10)\n with open('effects','a') as f: f.write(invocation()['jobId']+'\\n')\n if args.get('hold'): time.sleep(10)\n (failure if args.get('failure') else success)('observation complete', ['https://example.test/evidence'])\nrun(main)\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.lifecycle = { ...config.lifecycle, runTimeoutMs: 15000, abortTimeoutMs: 100, disposeTimeoutMs: 100 };
  config.mechanisticPrograms = mergeMechanisticPrograms({}, { observe: { python: "python3", script, cwd: root, description: "Read-only observation", inputExamples: ['{"id":9007199254740993,"zero":-0,"large":1e309}', '{ "failure": true }', '  { "note" : "a  b\\nline\\tend" }  '] } }, root);
  let idle = true;
  const deliveries: MainDelivery[] = [];
  const alerts: Array<{ text: string; triggerTurn?: boolean }> = [];
  const main: MainAdapter = { getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => idle,
    async deliver(delivery) { deliveries.push(delivery); await appendFile(join(root, "delivered"), delivery.envelope.id + "\n"); },
    notifyFailure(text, options) { alerts.push({ text, triggerTurn: options?.triggerTurn }); }, updateState() {} };
  const options = { cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], mainAdapter: main, projectTrusted: true, workerFactory: () => { throw new Error("No model worker allowed"); } };
  let broker = new AgentBroker(options); await broker.init();
  return { root, config, options, deliveries, alerts, get broker() { return broker; }, setIdle(value: boolean) { idle = value; },
    async reopen(expectedShutdownError?: RegExp) { if (expectedShutdownError) await assert.rejects(broker.shutdown(), expectedShutdownError); else await broker.shutdown(); broker = new AgentBroker(options); await broker.init(); },
    async close() { await broker.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
function send(broker: AgentBroker, direct = true, message = "{}", task = "test") { return broker.send(broker.mainAddress, { to: `observe.${task}@mechanistic.com`, subject: "observe", message, priority: "low" }, undefined, undefined, direct ? { triggerTurn: false } : undefined); }
async function settled(broker: AgentBroker, id: string) { await until(() => broker.inspectMechanisticJob(id).settled); return broker.mailStore.getJob(id)!; }

it("direct Python success/failure/progress and ordinary mail preserve distinct presentation policies", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    for (const [direct, body, expected] of [[true, "{}", "success"], [true, '{"failure":true}', "task_failure"], [true, "not json", "invalid_arguments"], [false, "{}", "success"]] as const) {
      const accepted = await send(f.broker, direct, body); const job = await settled(f.broker, accepted.envelope.id);
      assert.equal(job.result, expected); assert.equal(job.triggerTurn, direct ? false : undefined);
      const delivery = f.deliveries.find((entry) => entry.envelope.id === job.outcomeMailId)!;
      assert.equal(delivery.triggerTurn, !direct); assert.equal(delivery.envelope.triggerTurn, direct ? false : undefined);
      assert.equal(delivery.envelope.requiresResponse, false); assert.equal(job.cleanup?.state, "confirmed");
      assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 0);
      if (expected === "success") assert.ok(delivery.envelope.message.startsWith("observation complete"));
    }
    assert.deepEqual(f.alerts, []);
    await assert.rejects(f.broker.send(f.broker.mainAddress, { to: "worker.test@test.com", subject: "wrong", message: "{}", priority: "low" }, undefined, undefined, { triggerTurn: false }), /restricted to main/);
  } finally { await f.close(); }
});

it("busy-main direct outcomes retain false presentation through compaction, stop and reopen without replay", { timeout: 15000 }, async () => {
  const f = await fixture(); f.setIdle(false);
  try {
    const accepted = await send(f.broker); const job = await settled(f.broker, accepted.envelope.id);
    assert.equal(job.outcomeDeliveryState, "queued"); assert.equal(f.deliveries.length, 0);
    await f.broker.stop(job.address); await f.broker.mailStore.compact(); await f.reopen();
    assert.equal(f.broker.mailStore.getJob(job.id)?.triggerTurn, false);
    assert.equal(f.broker.mailStore.get(job.outcomeMailId!)?.triggerTurn, false);
    f.setIdle(true); await f.broker.flushQueuedMainMail();
    assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0]!.triggerTurn, false);
    assert.equal(f.deliveries[0]!.envelope.id, job.outcomeMailId);
    assert.equal(await readFile(join(f.root, "effects"), "utf8"), job.id + "\n");
  } finally { await f.close(); }
});

it("direct queued work and abandonment preserve presentation, capacity reservations and exact job identity", { timeout: 15000 }, async () => {
  const f = await fixture(); f.config.maxConcurrent = 1; f.config.maxQueuedMessages = 3; f.setIdle(false);
  try {
    const running = await send(f.broker, true, '{"hold":true}');
    await until(async () => (await readFile(join(f.root, "effects"), "utf8").catch(() => "")).includes(running.envelope.id));
    const queued = await send(f.broker); const abandoned = await send(f.broker);
    const count = f.broker.mailStore.list().length;
    await assert.rejects(send(f.broker, true, "{}", "over-capacity"), /queue.*full/i);
    assert.equal(f.broker.mailStore.list().length, count);
    await f.broker.stop(running.envelope.to); await f.reopen();
    assert.equal(f.broker.mailStore.getJob(running.envelope.id)?.result, "forced_stop");
    assert.equal(f.broker.mailStore.getJob(queued.envelope.id)?.phase, "queued");
    await f.broker.cancelRequest(abandoned.envelope.id, "Operator abandons only this unstarted direct job.");
    const abandonedJob = f.broker.mailStore.getJob(abandoned.envelope.id)!;
    assert.equal(abandonedJob.triggerTurn, false); assert.equal(f.broker.mailStore.get(abandonedJob.outcomeMailId!)?.triggerTurn, false);
    await f.broker.restart(running.envelope.to); const completed = await settled(f.broker, queued.envelope.id);
    assert.equal(completed.triggerTurn, false); assert.equal(completed.result, "success");
    f.setIdle(true); await f.broker.flushQueuedMainMail();
    assert.equal(f.deliveries.length, 3); assert.ok(f.deliveries.every((delivery) => delivery.triggerTurn === false));
    assert.equal(f.broker.mailStore.countPendingJobs(), 0);
    assert.equal((await readFile(join(f.root, "effects"), "utf8")).includes(abandoned.envelope.id), false);
  } finally { await f.close(); }
});

it("exact-job inspection waits for committed finalization authority, not a later job on the same identity", { timeout: 15000 }, async () => {
  const f = await fixture(); let release!: () => void; let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.broker.mailStore.finishJob.bind(f.broker.mailStore);
  f.broker.mailStore.finishJob = async (...args) => { await original(...args); if (!held) { held = true; await gate; } };
  try {
    const accepted = await send(f.broker); await until(() => held);
    assert.equal(f.broker.inspectMechanisticJob(accepted.envelope.id).job.phase, "terminal");
    assert.equal(f.broker.inspectMechanisticJob(accepted.envelope.id).settled, false);
    assert.equal(f.broker.inspectAgent(accepted.envelope.to).archiveEligible, false);
    release(); await settled(f.broker, accepted.envelope.id);
    const later = await send(f.broker, true, '{"hold":true}');
    await until(() => f.broker.mailStore.getJob(later.envelope.id)?.phase === "running");
    assert.equal(f.broker.inspectMechanisticJob(accepted.envelope.id).settled, true);
    assert.equal(f.broker.inspectMechanisticJob(later.envelope.id).settled, false);
    await f.broker.stop(later.envelope.to);
    await assert.rejects(async () => f.broker.inspectMechanisticJob("unknown"), /Unknown Python job/);
  } finally { release(); await f.close(); }
});

it("exact-job settlement follows start generation when high-priority mail overtakes older accepted work", { timeout: 15000 }, async () => {
  const f = await fixture(); let release!: () => void; let held = false; let target = "";
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finish = f.broker.mailStore.finishJob.bind(f.broker.mailStore);
  f.broker.mailStore.finishJob = async (...args) => { await finish(...args); if (args[0].id === target) { held = true; await gate; } };
  try {
    const first = await send(f.broker, true, '{"hold":true}');
    await until(() => f.broker.mailStore.getJob(first.envelope.id)?.phase === "running");
    const older = await send(f.broker); target = older.envelope.id;
    const newer = await f.broker.send(f.broker.mainAddress, { to: first.envelope.to, subject: "high priority observation", message: "{}", priority: "high" }, undefined, undefined, { triggerTurn: false });
    await f.broker.stop(first.envelope.to); await f.broker.restart(first.envelope.to); await until(() => held);
    assert.ok(f.broker.mailStore.getJob(target)!.generation! > f.broker.mailStore.getJob(newer.envelope.id)!.generation!);
    assert.equal(f.broker.inspectMechanisticJob(target).settled, false, "acceptance time is not exact run authority");
    assert.equal(f.broker.inspectMechanisticJob(newer.envelope.id).settled, true, "finished reordered sibling must not wait for the later live claim");
    assert.equal(f.broker.inspectAgent(first.envelope.to).archiveEligible, false);
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 1);
    release(); await settled(f.broker, target);
  } finally { release(); await f.close(); }
});

it("a real finalization write failure stays non-triggering and recovers the claimed ID without replay", { timeout: 15000 }, async () => {
  const f = await fixture(); let release!: () => void; let finalizing = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const path = f.broker.mailStore.path; const saved = `${path}.saved`;
  const original = f.broker.mailStore.finishJob.bind(f.broker.mailStore);
  f.broker.mailStore.finishJob = async (...args) => { finalizing = true; await gate; return original(...args); };
  try {
    const accepted = await send(f.broker); await until(() => finalizing);
    await rename(path, saved); await mkdir(path); release();
    await until(() => f.alerts.length === 1 && f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    assert.equal(f.alerts[0]!.triggerTurn, false); assert.match(f.alerts[0]!.text, /never replay/);
    assert.equal(f.broker.inspectMechanisticJob(accepted.envelope.id).settled, false);
    await rm(path, { recursive: true }); await rename(saved, path);
    await f.reopen(/poisoned until restart/);
    const recovered = f.broker.mailStore.getJob(accepted.envelope.id)!;
    assert.equal(recovered.result, "interrupted"); assert.equal(recovered.triggerTurn, false);
    assert.equal(recovered.cleanup?.state, "cleanup-unknown");
    assert.equal(f.deliveries.at(-1)!.triggerTurn, false);
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 0);
    assert.equal(await readFile(join(f.root, "effects"), "utf8"), accepted.envelope.id + "\n");
  } finally { release(); await f.close(); }
});

it("discovery is bounded and read-only, receipts compact, and durable presentation cannot be mutated", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const inspect = createMainCoordinationTools(() => f.broker)[0];
    const preview = await inspect.execute("inspect", { address: "observe.test@mechanistic.com" }, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(preview.content), /Read-only observation.*Input example/);
    const examples = preview.content.flatMap((part) => part.type === "text" ? [...part.text.matchAll(/^Input example: (.*)$/gm)].map((match) => match[1]!) : []);
    assert.deepEqual(examples, ['{"id":9007199254740993,"zero":-0,"large":1e309}', '{ "failure": true }', '  { "note" : "a  b\\nline\\tend" }  ']);
    for (const example of examples) assert.equal(typeof JSON.parse(example), "object");
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, 0);
    const prompt = mainCoordinatorPrompt(f.broker.mainAddress, "test", "off", [], 0, f.config);
    assert.ok(examples.every((example) => !prompt.includes(example)));
    const tools = createWorkerMailTools({ sendEmail: (input, signal) => f.broker.send(f.broker.mainAddress, input, signal), fetchEmails: () => ({ emails: [], total: 0 }) });
    const receipt = await tools[0].execute("send", { to: "observe.test@mechanistic.com", subject: "observation", message: "{}", priority: "low" }, undefined, undefined, undefined as never);
    const text = JSON.stringify(receipt.content);
    assert.match(text, /Python job accepted.*Acceptance is not completion.*never resend/);
    assert.doesNotMatch(text, /Correlation ID|Reply with|lifecycle|\/observe.py/);
    const ordinary = (receipt.details as SendToolDetails).result!; await settled(f.broker, ordinary.envelope.id);
    const dashboard = new DashboardComponent(() => f.broker.getSnapshot(), () => [], () => {}, () => {}, getThemeByName("dark")!, ordinary.envelope.to, undefined, 80, (address) => f.broker.inspectAgent(address));
    try {
      dashboard.handleInput("\r");
      const rendered = stripVTControlCharacters(dashboard.render(180).join("\n"));
      for (const example of examples) assert.ok(rendered.includes(`input: ${example}`), "dashboard preserves exact JSON text, including numeric spelling, escapes and spaces");
    } finally { dashboard.dispose(); }
    const direct = await send(f.broker, true, '{"hold":true}');
    await until(() => f.broker.mailStore.getJob(direct.envelope.id)?.phase === "running");
    const job = f.broker.mailStore.getJob(direct.envelope.id)!;
    await assert.rejects(f.broker.mailStore.updateJob({ ...job, triggerTurn: undefined }), /Invalid durable job transition/);
    for (const flag of [true, 0, null, "false"]) assert.throws(() => parseJob({ ...job, triggerTurn: flag }), /presentation choice/);
    const outcome = f.broker.mailStore.get(f.broker.mailStore.getJob(ordinary.envelope.id)!.outcomeMailId!)!;
    assert.throws(() => parseMailEvent({ type: "email.created", email: { ...outcome, triggerTurn: true } }), /presentation/);
    assert.throws(() => parseMailEvent({ type: "email.created", email: { ...outcome, from: "worker.test@test.com", triggerTurn: false } }), /presentation/);
    await f.broker.stop(job.address);
  } finally { await f.close(); }
});
