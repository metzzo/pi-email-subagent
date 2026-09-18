import assert from "node:assert/strict";
import { appendFile, access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import type { MainAdapter, MechanisticJob, SubagentConfig } from "../../src/types.ts";

async function until(check: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for real process evidence");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(code: string, overrides: Partial<SubagentConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mechanistic-real-"));
  const script = join(root, "job.py"); await writeFile(script, code);
  const config = { ...structuredClone(DEFAULT_CONFIG), ...overrides };
  config.lifecycle = { ...config.lifecycle, runTimeoutMs: 2000, abortTimeoutMs: 100, disposeTimeoutMs: 100 };
  config.mechanisticPrograms = mergeMechanisticPrograms({}, { worker: { python: "python3", script, cwd: root, allowedCallers: ["main", "llm", "mechanistic"] } }, root);
  // Only the absent Pi presentation surface is adapted here. Real broker,
  // journal, registrations, lifecycle, helper and Python processes are exercised.
  const main: MainAdapter = {
    getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => true,
    deliver: async ({ envelope }) => { await appendFile(join(root, "main.jsonl"), `${JSON.stringify(envelope)}\n`); },
    notifyFailure: (message) => { void appendFile(join(root, "alerts.log"), `${message}\n`); }, updateState: () => {},
  };
  const broker = new AgentBroker({ cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], mainAdapter: main, workerFactory: () => { throw new Error("No LLM worker may be created in real-Python tests"); }, projectTrusted: true });
  await broker.init();
  return { root, config, broker, async close() { await broker.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function file(path: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!await exists(path)) { if (Date.now() > end) throw new Error(`No real file ${path}`); await new Promise((r) => setTimeout(r, 10)); }
}
async function send(broker: AgentBroker, message = "{}", task = "test", priority: "low" | "high" = "low") {
  return broker.send(broker.mainAddress, { to: `worker.${task}@mechanistic.com`, subject: "real job", message, priority });
}
async function terminal(broker: AgentBroker, id: string): Promise<MechanisticJob> {
  await until(() => broker.mailStore.getJob(id)?.phase === "terminal");
  return broker.mailStore.getJob(id)!;
}

for (const [name, code, expected] of [
  ["success", "from pi_mechanistic import success\nsuccess('done')\n", "success"],
  ["task failure", "from pi_mechanistic import failure\nfailure('task rejected')\n", "task_failure"],
  ["invalid arguments", "from pi_mechanistic import run, InvalidArguments\ndef main(args):\n raise InvalidArguments('missing operation')\nrun(main)\n", "invalid_arguments"],
  ["missing terminal", "pass\n", "missing_terminal"],
  ["crash contradicts success", "from pi_mechanistic import success\nsuccess('reported success')\nraise RuntimeError('crash after report')\n", "crash"],
  ["invalid frame", "print('not-json', flush=True)\n", "protocol_failure"],
  ["unterminated frame", "import sys\nsys.stdout.write('{}')\n", "protocol_failure"],
  ["oversized frame", "print('x' * 65537, flush=True)\n", "protocol_failure"],
  ["duplicate terminal", "import json\nfor i in [1,2]: print(json.dumps(dict(v=1,id=i,op='success',summary='done')),flush=True)\n", "protocol_failure"],
  ["timeout", "import time\ntime.sleep(10)\n", "timeout"],
] as const) {
  it(`real Python ${name} has a separate runtime outcome and one uncorrelated notification`, async () => {
    const f = await fixture(code);
    try {
      const accepted = await send(f.broker);
      assert.equal(accepted.envelope.requiresResponse, false);
      assert.equal(accepted.recipientKind, "mechanistic");
      assert.equal(accepted.recipientModel, undefined);
      const job = await terminal(f.broker, accepted.envelope.id);
      assert.equal(job.result, expected, JSON.stringify(job));
      assert.equal(job.cleanup?.state, "confirmed");
      const notification = f.broker.mailStore.get(job.outcomeMailId!)!;
      assert.equal(notification.kind, "notification"); assert.equal(notification.inReplyTo, undefined);
      assert.equal(notification.to, f.broker.mainAddress); assert.equal(notification.from, accepted.envelope.to);
      assert.equal(f.broker.mailStore.list().length, 2);
      assert.equal(f.broker.mailStore.listJobs().length, 1);
      await assert.rejects(f.broker.waitForReplies([job.id], 0), /no response obligation/);
      assert.throws(() => f.broker.fetchUnanswered(accepted.envelope.to), /send-only/);
    } finally { await f.close(); }
  });
}

it("malformed JSON is accepted and classified by the real helper without losing its ID", async () => {
  const f = await fixture("from pi_mechanistic import run, success\nrun(lambda args: success('okay'))\n");
  try {
    const accepted = await send(f.broker, "{bad-json");
    assert.equal((await terminal(f.broker, accepted.envelope.id)).result, "invalid_arguments");
  } finally { await f.close(); }
});

it("rejects all send-only violations and unknown programs before journal acceptance", async () => {
  const f = await fixture("raise RuntimeError('must not run')\n");
  try {
    for (const extra of [{ requires_response: true }, { reply_to: "mail_other" }, { subject: "Re: [mail_other] old" }, { effort: "low" }, { completion: {} }]) {
      await assert.rejects(f.broker.send(f.broker.mainAddress, { to: "worker.test@mechanistic.com", subject: "test", message: "{}", priority: "low", ...extra } as never));
    }
    await assert.rejects(f.broker.send(f.broker.mainAddress, { to: "unknown.test@mechanistic.com", subject: "test", message: "{}", priority: "low" }), /Unknown/);
    assert.deepEqual(f.broker.mailStore.list(), []); assert.deepEqual(f.broker.mailStore.listJobs(), []);
    assert.deepEqual(f.broker.getSnapshot().agents, []);
  } finally { await f.close(); }
});

it("real helper progress and sends retain broker IDs and never generate correlated outcomes", async () => {
  const f = await fixture("from pi_mechanistic import *\nimport json\nfor i in range(200): progress('latest '+str(i), i/2)\nack = send_email(invocation()['mainAddress'], 'evidence', 'observed real input')\nassert ack['accepted'] and ack['mailId']\nsuccess(ack['mailId'])\n");
  try {
    const accepted = await send(f.broker);
    const job = await terminal(f.broker, accepted.envelope.id);
    assert.equal(job.result, "success", JSON.stringify(job));
    assert.match(job.progress?.message ?? "", /latest/);
    assert.equal(f.broker.mailStore.list().length, 3);
    const selected = f.broker.mailStore.get(job.reported!.summary)!;
    assert.equal(selected.from, accepted.envelope.to); assert.equal(selected.requiresResponse, false);
  } finally { await f.close(); }
});

it("serializes one address, prioritizes high queued jobs, and never runs an accepted ID twice", async () => {
  const f = await fixture("from pi_mechanistic import *\nfrom pathlib import Path\nimport time,json\na=arguments()\nwith open('starts.jsonl','a') as s: s.write(json.dumps([a['tag'],invocation()['jobId']])+'\\n')\nPath(a['tag']+'.started').touch()\nwhile a['tag']=='first' and not Path('release').exists(): time.sleep(.01)\nsuccess(a['tag'])\n");
  try {
    const first = await send(f.broker, '{"tag":"first"}'); await file(join(f.root, "first.started"));
    const low = await send(f.broker, '{"tag":"low"}'); const high = await send(f.broker, '{"tag":"high"}', "test", "high");
    assert.equal(f.broker.mailStore.getJob(low.envelope.id)!.phase, "queued");
    assert.equal(f.broker.mailStore.getJob(high.envelope.id)!.phase, "queued");
    await writeFile(join(f.root, "release"), "");
    for (const mail of [first, high, low]) assert.equal((await terminal(f.broker, mail.envelope.id)).result, "success");
    assert.deepEqual((await readFile(join(f.root, "starts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [["first", first.envelope.id], ["high", high.envelope.id], ["low", low.envelope.id]]);
    // Terminal evidence precedes completion of registry/main publication. Wait
    // for its actual run-slot release before requesting an explicit restart.
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    await f.broker.restart(first.envelope.to);
    assert.equal((await readFile(join(f.root, "starts.jsonl"), "utf8")).trim().split("\n").length, 3);
  } finally { await f.close(); }
});

it("shares identity/run capacity; stop retains queued work and archive releases only a clean lease", async () => {
  const f = await fixture("from pi_mechanistic import *\nfrom pathlib import Path\nimport time\na=arguments()\nPath(a['tag']).touch()\nwhile not Path('release').exists(): time.sleep(.01)\nsuccess('released')\n", { maxAgents: 2, maxConcurrent: 1 });
  try {
    const first = await send(f.broker, '{"tag":"first"}', "first"); await file(join(f.root, "first"));
    const second = await send(f.broker, '{"tag":"second"}', "second");
    assert.equal(f.broker.getSnapshot().capacity.runSlotsUsed, 1);
    await assert.rejects(send(f.broker, '{"tag":"third"}', "third"), /capacity/i);
    assert.equal(f.broker.mailStore.listJobs().length, 2);
    await f.broker.stop(second.envelope.to);
    await f.broker.stop(first.envelope.to);
    assert.equal((await terminal(f.broker, first.envelope.id)).result, "forced_stop");
    assert.equal(await exists(join(f.root, "second")), false);
    await assert.rejects(f.broker.archive(second.envelope.to), /queued/i);
    await f.broker.archive(first.envelope.to);
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, 1);
    await writeFile(join(f.root, "release"), "");
    await f.broker.restart(second.envelope.to);
    assert.equal((await terminal(f.broker, second.envelope.id)).result, "success");
  } finally { await f.close(); }
});

it("bounded stderr does not consume protocol frames or turn a crash into success", async () => {
  const f = await fixture("import sys\nfrom pi_mechanistic import success\nsys.stderr.write('x'*200000+'last-log-evidence')\nsys.stderr.flush()\nsuccess('reported')\nraise SystemExit(7)\n");
  try {
    const job = await terminal(f.broker, (await send(f.broker)).envelope.id);
    assert.equal(job.result, "crash"); assert.equal(job.exitCode, 7); assert.equal(job.reported!.status, "success");
    assert.ok(Buffer.byteLength(job.stderr) <= 65536); assert.ok(job.stderr.endsWith("last-log-evidence"));
  } finally { await f.close(); }
});

it("unknown inherited-pipe cleanup quarantines the exact identity and explicit release preserves history", async () => {
  const f = await fixture("import subprocess,sys\nfrom pi_mechanistic import success\nsubprocess.Popen([sys.executable,'-c','import time; time.sleep(.8)'])\nsuccess('direct child reported')\n");
  try {
    const first = await send(f.broker); const job = await terminal(f.broker, first.envelope.id);
    assert.equal(job.cleanup?.state, "cleanup-unknown", JSON.stringify(job));
    assert.equal(job.cleanup?.childExited, true); assert.equal(job.reported?.status, "success");
    await assert.rejects(f.broker.restart(first.envelope.to), /cleanup.*unknown/i);
    await assert.rejects(f.broker.archive(first.envelope.to), /cleanup/i);
    const queued = await send(f.broker); assert.equal(f.broker.mailStore.getJob(queued.envelope.id)?.phase, "queued");
    await f.broker.clearFailure(first.envelope.to);
    assert.equal(f.broker.mailStore.getJob(job.id)?.cleanup?.state, "cleanup-unknown");
    assert.equal(f.broker.inspectAgent(first.envelope.to).state, "stopped");
    // The intentionally inherited descendant is finite; leave no live test work.
    await new Promise((r) => setTimeout(r, 850));
  } finally { await f.close(); }
});

for (const example of ["command", "status_file"]) {
  it(`bundled ${example} example uses real disposable local inputs`, async () => {
    const code = await readFile(resolve(`src/python/examples/${example}.py`), "utf8"); const f = await fixture(code);
    try {
      if (example === "command") {
        const { execFileSync } = await import("node:child_process"); execFileSync("git", ["init", "--quiet"], { cwd: f.root });
      } else await writeFile(join(f.root, "status.txt"), "ready\n");
      const body = example === "command" ? { operation: "git-status" } : { expected: "ready", attempts: 2 };
      const job = await terminal(f.broker, (await send(f.broker, JSON.stringify({ ...body, notify_to: f.broker.mainAddress }))).envelope.id);
      assert.equal(job.result, "success", JSON.stringify(job)); assert.equal(job.reported?.artifacts?.length, 1);
      assert.equal(f.broker.mailStore.list().length, 3);
      const bad = await terminal(f.broker, (await send(f.broker, '{"operation":"echo arbitrary; touch stolen"}')).envelope.id);
      assert.equal(bad.result, "invalid_arguments"); assert.equal(await exists(join(f.root, "stolen")), false);
    } finally { await f.close(); }
  });
}

