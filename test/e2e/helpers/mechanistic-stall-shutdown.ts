import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentBroker } from "../../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../../src/config.ts";
import { mergeMechanisticPrograms } from "../../../src/mechanistic.ts";

const [root, phase] = process.argv.slice(2) as [string, string];
const config = structuredClone(DEFAULT_CONFIG);
config.lifecycle = { ...config.lifecycle, runTimeoutMs: 2000, abortTimeoutMs: 50, disposeTimeoutMs: 50, brokerShutdownTimeoutMs: 250 };
const script = join(root, "job.py");
await writeFile(script, phase === "terminal" ? "from pi_mechanistic import success\nsuccess('done')\n" : "from pi_mechanistic import progress\nimport time\nprogress('committed')\ntime.sleep(2)\n");
config.mechanisticPrograms = mergeMechanisticPrograms({}, { worker: { python: "python3", script, cwd: root } }, root);
const options = { cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], projectTrusted: true,
  mainAdapter: { getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => false, async deliver() {}, notifyFailure() {}, updateState() {} },
  workerFactory: () => { throw new Error("No LLM expected"); } };
const broker = new AgentBroker(options); await broker.init();
const held = new Promise<void>(() => {}); let committed = false;
const update = broker.mailStore.updateJob.bind(broker.mailStore);
const finish = broker.mailStore.finishJob.bind(broker.mailStore);
broker.mailStore.updateJob = async (job) => { await update(job); if (!committed && ((phase === "running" && job.phase === "running") || (phase === "progress" && job.progress))) { committed = true; await held; } };
broker.mailStore.finishJob = async (job, mail) => { await finish(job, mail); if (phase === "terminal") { committed = true; await held; } };
const accepted = await broker.send(broker.mainAddress, { to: "worker.stall@mechanistic.com", subject: "stall", message: "{}", priority: "low" });
const end = Date.now() + 5000;
while (!committed) { if (Date.now() > end) throw new Error("Real callback did not commit"); await new Promise((resolve) => setTimeout(resolve, 10)); }
const before = broker.mailStore.getJob(accepted.envelope.id)!;
await assert.rejects(broker.stop(accepted.envelope.to), /LIFECYCLE_MECHANISTIC_SETTLEMENT_TIMEOUT/);
assert.throws(() => process.kill(before.pid!, 0), /ESRCH/);
await assert.rejects(broker.restart(accepted.envelope.to), /Stop and settle/);
const started = Date.now();
await assert.rejects(broker.shutdown(), /LIFECYCLE_BROKER_SHUTDOWN.*TIMEOUT/);
const elapsed = Date.now() - started; assert.ok(elapsed < 1500);
assert.equal(broker.getSnapshot().capacity.runSlotsUsed, 1);
assert.equal(broker.mailStore.getJob(before.id)?.phase === "terminal", phase === "terminal");
const rival = new AgentBroker(options); await assert.rejects(rival.init(), /owner|locked|ownership/i); await rival.shutdown().catch(() => undefined);
await writeFile(join(root, "proof.json"), JSON.stringify({ pid: before.pid, elapsed, job: broker.mailStore.getJob(before.id), journal: await readFile(broker.mailStore.path, "utf8") }));
// The retained lease deliberately cannot be released by a live owner. This
// isolated host exits only after proving child death and fail-closed ownership.
process.exit(0);
