import assert from "node:assert/strict";
import { appendFile, access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import { outcomeText } from "../../src/mechanistic-job.ts";
import { formatEmail } from "../../src/prompts.ts";
import { MAIL_TOOL_BATCH_LINES } from "../../src/tool-result.ts";
import { DashboardComponent } from "../../src/ui.ts";
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
  let mainIdle = true;
  const main: MainAdapter = {
    getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => mainIdle,
    deliver: async ({ envelope, formatted }) => {
      await appendFile(join(root, "main.jsonl"), `${JSON.stringify(envelope)}\n`);
      await appendFile(join(root, "main-formatted.jsonl"), `${JSON.stringify({ id: envelope.id, formatted })}\n`);
    },
    notifyFailure: (message) => { appendFileSync(join(root, "alerts.log"), `${message}\n`); }, updateState: () => {},
  };
  const options = { cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], mainAdapter: main, workerFactory: () => { throw new Error("No LLM worker may be created in real-Python tests"); }, projectTrusted: true };
  let broker = new AgentBroker(options);
  await broker.init();
  return { root, config, setMainIdle(idle: boolean) { mainIdle = idle; }, get broker() { return broker; }, async reopen() { await broker.shutdown(); broker = new AgentBroker(options); await broker.init(); }, async close() { await broker.shutdown(); await rm(root, { recursive: true, force: true }); } };
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
  ["forged abandonment operation", "print('{\"v\":1,\"id\":1,\"op\":\"abandoned\",\"summary\":\"not allowed\"}',flush=True)\n", "protocol_failure"],
  ["forged abandonment result", "print('{\"v\":1,\"id\":1,\"op\":\"success\",\"summary\":\"not allowed\",\"result\":\"abandoned\"}',flush=True)\n", "protocol_failure"],
  ["crash contradicts success", "from pi_mechanistic import success\nsuccess('reported success')\nraise RuntimeError('crash after report')\n", "crash"],
  ["invalid frame", "print('not-json', flush=True)\n", "protocol_failure"],
  ["unterminated frame", "import sys\nsys.stdout.write('{}')\n", "protocol_failure"],
  ["oversized frame", "print('x' * 65537, flush=True)\n", "protocol_failure"],
  ["duplicate terminal", "import json\nfor i in [1,2]: print(json.dumps(dict(v=1,id=i,op='success',summary='done')),flush=True)\n", "protocol_failure"],
  ["timeout", "import time\ntime.sleep(10)\n", "timeout"],
  ["unknown operation", "print('{\"v\":1,\"id\":1,\"op\":\"fetch_emails\"}',flush=True)\n", "protocol_failure"],
  ["unknown ID", "print('{\"v\":1,\"id\":2,\"op\":\"success\",\"summary\":\"done\"}',flush=True)\n", "protocol_failure"],
  ["duplicate command ID", "print('{\"v\":1,\"id\":1,\"op\":\"progress\",\"message\":\"a\"}\\n{\"v\":1,\"id\":1,\"op\":\"progress\",\"message\":\"b\"}',flush=True)\n", "protocol_failure"],
  ["post-terminal command", "print('{\"v\":1,\"id\":1,\"op\":\"success\",\"summary\":\"done\"}\\n{\"v\":1,\"id\":2,\"op\":\"progress\",\"message\":\"late\"}',flush=True)\n", "protocol_failure"],
  ["oversized artifact", "import json\nprint(json.dumps(dict(v=1,id=1,op='success',summary='done',artifacts=['x'*2049])),flush=True)\n", "protocol_failure"],
  ["excess artifacts", "import json\nprint(json.dumps(dict(v=1,id=1,op='success',summary='done',artifacts=['x']*33)),flush=True)\n", "protocol_failure"],
  ["invalid UTF-8", "import os\nos.write(1,b'\\xff\\n')\n", "protocol_failure"],
  ["excess unacknowledged sends", "import json\nfor i in range(1,40): print(json.dumps(dict(v=1,id=i,op='send_email',to='main@test.com',subject='evidence',message='body')),flush=True)\n", "protocol_failure"],
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
      const mail = f.broker.mailStore.list();
      if (name === "excess unacknowledged sends") {
        // Earlier commands can already be durably accepted when the outstanding
        // command bound is crossed. Preserve those IDs; do not claim rollback.
        assert.ok(mail.length >= 2 && mail.length <= 18);
        assert.equal(new Set(mail.map((entry) => entry.id)).size, mail.length);
        assert.equal(mail.filter((entry) => entry.id === job.outcomeMailId).length, 1);
      } else assert.equal(mail.length, 2);
      assert.equal(f.broker.mailStore.listJobs().length, 1);
      await assert.rejects(f.broker.waitForReplies([job.id], 0), /no response obligation/);
      assert.throws(() => f.broker.fetchUnanswered(accepted.envelope.to), /send-only/);
    } finally { await f.close(); }
  });
}

for (const body of ["{bad-json", "[]", "null", "true", '{"value":NaN}', '{"value":Infinity}', '{"value":-Infinity}']) it(`invalid JSON object ${body} is accepted and classified by the real helper without losing its ID`, async () => {
  const f = await fixture("from pi_mechanistic import run, success\nrun(lambda args: success('okay'))\n");
  try {
    const accepted = await send(f.broker, body);
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
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    await f.broker.clearFailure(first.envelope.to);
    assert.equal(f.broker.mailStore.getJob(job.id)?.cleanup?.state, "cleanup-unknown");
    assert.equal(f.broker.inspectAgent(first.envelope.to).state, "stopped");
    const [inspect] = createMainCoordinationTools(async () => f.broker);
    const inspected = await inspect.execute("cleanup", { address: first.envelope.to }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(inspected.content), /cleanup: cleanup-unknown/);
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


it("real main management tools render and manage Python identities without LLM recovery controls", async () => {
  const f = await fixture("from pi_mechanistic import success\nsuccess('done')\n");
  try {
    const accepted = await send(f.broker); await terminal(f.broker, accepted.envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    themeModule.initTheme("dark", false);
    const [inspect, wait, cancel, manage] = createMainCoordinationTools(async () => f.broker);
    const inspected = await inspect.execute("inspect", { address: accepted.envelope.to }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(inspected.content), /send-only Python|Python.*send-only/i);
    await assert.rejects(wait.execute("wait", { request_ids: [accepted.envelope.id], timeout_seconds: 0 }, undefined, undefined, {} as never), /no response obligation/);
    await assert.rejects(cancel.execute("cancel", { request_id: accepted.envelope.id, reason: "There is no response obligation to cancel" }, undefined, undefined, {} as never));
    for (const action of ["stop", "clear_failure", "restart", "archive"] as const) {
      const params = { address: accepted.envelope.to, action };
      assert.match(manage.renderCall!(params, themeModule.theme, {} as never).render(100).join("\n"), new RegExp(action));
      const result = await manage.execute(action, params, undefined, undefined, {} as never);
      assert.match(JSON.stringify(result.content), new RegExp(`${action} completed`));
      if (action === "restart") assert.match(JSON.stringify(result.content), /No interrupted job is replayed/);
    }
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, 0);
  } finally { await f.close(); }
});

for (const allowed of [false, true]) {
  it(`mechanistic caller kind requires explicit opt-in: allowed=${allowed}`, async () => {
    const f = await fixture("from pi_mechanistic import *\nfrom pathlib import Path\nimport json\na=arguments()\nif a.get('send'):\n ack=send_email('worker.child@mechanistic.com','child invocation','{}')\n Path('ack.json').write_text(json.dumps(ack))\nsuccess('done')\n");
    try {
      f.config.mechanisticPrograms.worker!.allowedCallers = allowed ? ["main", "mechanistic"] : ["main"];
      const parent = await send(f.broker, '{"send":true}', "parent"); await terminal(f.broker, parent.envelope.id);
      await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
      const ack = JSON.parse(await readFile(join(f.root, "ack.json"), "utf8"));
      assert.equal(ack.accepted, allowed); assert.equal(ack.ok, allowed);
      assert.equal(f.broker.mailStore.listJobs().length, allowed ? 2 : 1);
      if (allowed) { const child = f.broker.mailStore.getJob(ack.mailId)!; assert.equal(child.result, "success"); assert.equal(f.broker.mailStore.get(child.id)?.from, parent.envelope.to); }
      else { assert.match(ack.error, /does not authorize mechanistic callers/); assert.equal(ack.mailId, undefined); }
    } finally { await f.close(); }
  });
}

for (const rejected of [true, false]) {
  it(`helper preserves ${rejected ? "rejection" : "post-acceptance uncertainty"} without resending`, async () => {
    const f = await fixture("from pi_mechanistic import *\nfrom pathlib import Path\nimport json\na=arguments()\nack=send_email(a['to'],'one-send','one-body')\nPath('ack.json').write_text(json.dumps(ack))\nsuccess('ack recorded')\n");
    try {
      if (!rejected) await mkdir(join(f.root, "main.jsonl")); // real EISDIR after acceptance
      const accepted = await send(f.broker, JSON.stringify({ to: rejected ? "missing.test@mechanistic.com" : f.broker.mainAddress }));
      const job = await terminal(f.broker, accepted.envelope.id);
      await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
      assert.equal(job.result, "success");
      const ack = JSON.parse(await readFile(join(f.root, "ack.json"), "utf8"));
      assert.equal(ack.ok, false); assert.equal(ack.accepted, !rejected);
      const outgoing = f.broker.mailStore.list().filter((entry) => entry.subject === "one-send");
      assert.equal(outgoing.length, rejected ? 0 : 1);
      if (rejected) assert.equal(ack.mailId, undefined);
      else {
        assert.equal(ack.mailId, outgoing[0]!.id); assert.equal(ack.deliveryUncertain, true);
        assert.equal(outgoing[0]!.deliveryState, "failed");
        assert.equal(job.cleanup?.state, "confirmed", "delivery failure does not rewrite direct-child proof");
      }
    } finally { await f.close(); }
  });
}

it("an unavailable interpreter is a real post-acceptance spawn failure", async () => {
  const f = await fixture("raise RuntimeError('must not execute')\n");
  try {
    const executable = join(f.root, "unavailable-interpreter");
    await writeFile(executable, "#!/definitely-unavailable/pi-python-interpreter\n"); await chmod(executable, 0o700);
    f.config.mechanisticPrograms.worker!.python = executable;
    const accepted = await send(f.broker); const job = await terminal(f.broker, accepted.envelope.id);
    assert.equal(job.result, "spawn_failure"); assert.equal(job.pid, undefined); assert.equal(job.cleanup?.state, "confirmed");
    assert.match(job.stderr, /ENOENT|spawn/);
  } finally { await f.close(); }
});

it("binding removal, conflicting replacement and reinstatement never silently rebind or replay", async () => {
  const f = await fixture("from pi_mechanistic import success\nwith open('effects','a') as f: f.write('once\\n')\nsuccess('done')\n");
  try {
    const original = structuredClone(f.config.mechanisticPrograms.worker!);
    const accepted = await send(f.broker); await terminal(f.broker, accepted.envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    delete f.config.mechanisticPrograms.worker; await f.reopen();
    const unavailable = f.broker.inspectAgent(accepted.envelope.to);
    assert.equal(unavailable.kind, "mechanistic"); if (unavailable.kind !== "mechanistic") throw new Error("wrong kind");
    assert.equal(unavailable.bindingReady, "unavailable");
    await assert.rejects(send(f.broker), /Unknown or removed/);
    const replacement = join(f.root, "replacement.py"); await writeFile(replacement, "raise RuntimeError('must not run')\n");
    f.config.mechanisticPrograms.worker = { ...original, script: replacement };
    await assert.rejects(send(f.broker), /binding.*unavailable/);
    assert.equal(f.broker.mailStore.listJobs().length, 1);
    f.config.mechanisticPrograms.worker = original; await f.reopen();
    await f.broker.clearFailure(accepted.envelope.to); await f.broker.restart(accepted.envelope.to);
    assert.equal((await readFile(join(f.root, "effects"), "utf8")), "once\n");
    const next = await send(f.broker); await terminal(f.broker, next.envelope.id);
    assert.notEqual(next.envelope.id, accepted.envelope.id);
    assert.equal(await readFile(join(f.root, "effects"), "utf8"), "once\nonce\n");
    assert.equal(f.broker.mailStore.getJob(accepted.envelope.id)!.result, "success");
  } finally { await f.close(); }
});

for (const operation of ["stop", "shutdown"] as const) {
  it(`immediate ${operation} settles start races without replay or leaked children`, async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture("import time\nfrom pi_mechanistic import success\ntime.sleep(2)\nsuccess('late')\n");
      try {
        const accepted = await send(f.broker);
        if (operation === "stop") await f.broker.stop(accepted.envelope.to); else await f.broker.shutdown();
        const job = await terminal(f.broker, accepted.envelope.id);
        assert.equal(job.result, "forced_stop"); assert.equal(job.cleanup?.state, "confirmed");
        await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
        if (job.pid) assert.throws(() => process.kill(job.pid!, 0), /ESRCH/);
        assert.equal(f.broker.mailStore.listJobs().length, 1);
      } finally { await f.close(); }
    }
  });
}

it("a SIGTERM-resistant child is finitely killed and a progress flood stays coalesced", async () => {
  const f = await fixture("import signal,time\nfrom pathlib import Path\nfrom pi_mechanistic import progress\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath('ready').touch()\nfor i in range(4000): progress('latest '+str(i),i/40)\nwhile True: time.sleep(.01)\n");
  try {
    const accepted = await send(f.broker); await file(join(f.root, "ready"));
    await until(() => Boolean(f.broker.mailStore.getJob(accepted.envelope.id)?.progress));
    await f.broker.stop(accepted.envelope.to); const job = await terminal(f.broker, accepted.envelope.id);
    assert.equal(job.result, "forced_stop"); assert.equal(job.signal, "SIGKILL"); assert.equal(job.cleanup?.state, "confirmed");
    const events = (await readFile(join(f.root, "state/mail.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.filter((event) => event.type === "job.updated" && event.job?.progress).length <= 12, "progress publication is time-coalesced, not one journal write per command");
  } finally { await f.close(); }
});

for (const limits of [{}, { maxMessageBytes: 1024, maxBatchBytes: 2048 }, { maxMessageBytes: 256, maxSubjectBytes: 8 }, { maxQueuedBytes: 200 }]) {
  it(`maximal escaped Python reports keep full durable evidence and a bounded outcome (${JSON.stringify(limits)})`, async () => {
    const f = await fixture("from pathlib import Path\nfrom pi_mechanistic import success\nwith open('starts','a') as s: s.write('once\\n')\nsuccess('&'*4096, ['&'*2048]*29)\n", limits);
    try {
      const accepted = await send(f.broker);
      const job = await terminal(f.broker, accepted.envelope.id);
      await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
      assert.equal(job.result, "success"); assert.equal(job.reported?.summary, "&".repeat(4096));
      assert.deepEqual(job.reported.artifacts, Array(29).fill("&".repeat(2048)));
      const outcome = f.broker.mailStore.get(job.outcomeMailId!)!;
      console.log(`outcome report bytes: body=${Buffer.byteLength(outcome.message)}, formatted=${Buffer.byteLength(formatEmail(outcome))}`);
      assert.ok(Buffer.byteLength(outcome.message) <= f.config.maxMessageBytes, "derived outcome body respects normal configured mail limit");
      assert.ok(Buffer.byteLength(formatEmail(outcome)) <= f.broker.toolResultByteLimit, "escaped outcome respects normal context limit");
      assert.ok(formatEmail(outcome).split("\n").length <= MAIL_TOOL_BATCH_LINES);
      assert.match(outcome.message, /omitted/); assert.ok(outcome.message.includes(job.id));
      const references = outcome.message.split("\n").find((line) => line.startsWith("Artifact references (not verified): "));
      const shown: string[] = references ? JSON.parse(references.slice("Artifact references (not verified): ".length)) : [];
      assert.ok(shown.every((reference) => reference === "&".repeat(2048)));
      if (!outcome.message.includes("outcome details omitted")) assert.ok(outcome.message.includes(`${29 - shown.length} artifact references omitted`));
      assert.equal(outcome.deliveryState, "delivered"); assert.equal(outcome.kind, "notification");
      const delivered = JSON.parse((await readFile(join(f.root, "main-formatted.jsonl"), "utf8")).trim());
      assert.equal(delivered.id, outcome.id); assert.equal(delivered.formatted, formatEmail(outcome));
      assert.equal(outcome.requiresResponse, false); assert.equal(outcome.inReplyTo, undefined);
      await f.broker.mailStore.compact(); await f.reopen();
      assert.deepEqual(f.broker.mailStore.getJob(job.id)?.reported, job.reported);
      assert.equal(f.broker.mailStore.getJob(job.id)?.outcomeMailId, outcome.id);
      assert.equal(f.broker.mailStore.list().filter((mail) => mail.id === outcome.id).length, 1);
      assert.equal((await readFile(join(f.root, "main.jsonl"), "utf8")).trim().split("\n").filter((line) => JSON.parse(line).id === outcome.id).length, 1);
      assert.equal(await readFile(join(f.root, "starts"), "utf8"), "once\n");
    } finally { await f.close(); }
  });
}

it("busy-main capacity is checked before accepting a job with an automatic outcome", async () => {
  const f = await fixture("from pi_mechanistic import success\nsuccess('small')\n", { maxQueuedMessages: 1 });
  try {
    f.setMainIdle(false);
    const first = await terminal(f.broker, (await send(f.broker)).envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    assert.equal(f.broker.mailStore.get(first.outcomeMailId!)?.deliveryState, "queued");
    await assert.rejects(send(f.broker), /queue for main is full/i);
    assert.equal(f.broker.mailStore.listJobs().length, 1);
    f.setMainIdle(true); await f.broker.flushQueuedMainMail();
    const job = await terminal(f.broker, (await send(f.broker)).envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    const outcome = f.broker.mailStore.get(job.outcomeMailId!)!;
    assert.equal(outcome.message, outcomeText(job), "small outcome text is unchanged");
    assert.equal(outcome.deliveryState, "delivered");
  } finally { await f.close(); }
});

for (const logIndex of [0, 2]) it(`inspection preserves every recent summary with huge stderr in job ${logIndex}`, async () => {
  const f = await fixture("import sys\nfrom pi_mechanistic import arguments, progress, success\na=arguments()\nprogress('observing '+a['summary'],50)\nif a.get('log'): sys.stderr.write('x'*65536+'VISIBLE_LOG_TAIL')\nsuccess(a['summary'])\n");
  try {
    const jobs: MechanisticJob[] = [];
    for (const [index, summary] of ["older", "later-one", "later-two"].entries()) {
      jobs.push(await terminal(f.broker, (await send(f.broker, JSON.stringify({ log: index === logIndex, summary }))).envelope.id));
      await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    }
    const [inspect] = createMainCoordinationTools(async () => f.broker);
    const result = await inspect.execute("inspect", { address: "worker.test@mechanistic.com" }, undefined, undefined, {} as never);
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    const details = result.details as { inspection: { jobs: MechanisticJob[] } };
    assert.equal(details.inspection.jobs[logIndex]?.stderr, jobs[logIndex]?.stderr);
    for (const job of jobs) { assert.ok(text.includes(job.id), `inspection includes job ${job.id}`); assert.ok(text.includes(job.reported!.summary)); }
    assert.match(text, /VISIBLE_LOG_TAIL/); assert.match(text, /observing later-two/);
    assert.ok(text.indexOf(jobs[2]!.id) < text.indexOf(jobs[0]!.id));
    const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    themeModule.initTheme("dark", false);
    const dashboard = new DashboardComponent(() => f.broker.getSnapshot(), () => [], () => {}, () => {}, themeModule.theme, "worker.test@mechanistic.com", undefined, 80, (address) => f.broker.inspectAgent(address));
    try {
      dashboard.handleInput("\r"); const rendered = dashboard.render(200).join("\n");
      assert.ok(rendered.indexOf(jobs[2]!.id) < rendered.indexOf(jobs[0]!.id));
      assert.match(rendered, /later-one|later-two/);
    } finally { dashboard.dispose(); }
  } finally { await f.close(); }
});

for (const restoredLimit of [3, 2]) it(`accepted jobs preserve main-queue reservations through stop/restore (limit ${restoredLimit})`, async () => {
  const f = await fixture("import json,time\nfrom pathlib import Path\nfrom pi_mechanistic import *\na=arguments()\nwith open('starts','a') as s: s.write(a['tag']+'\\n')\nif a['tag']=='first':\n Path('ready').touch()\n while not Path('send').exists(): time.sleep(.01)\n acks=[send_email(invocation()['mainAddress'],'ordinary-'+str(i),'observed','high') for i in range(2)]\n Path('acks.tmp').write_text(json.dumps(acks)); Path('acks.tmp').replace('acks.json')\n while True: time.sleep(.01)\nsuccess(a['tag'])\n", { maxQueuedMessages: 3 });
  try {
    f.setMainIdle(false);
    const first = await send(f.broker, '{"tag":"first"}'); await file(join(f.root, "ready"));
    const second = await send(f.broker, '{"tag":"second"}');
    await writeFile(join(f.root, "send"), ""); await file(join(f.root, "acks.json"));
    const acks = JSON.parse(await readFile(join(f.root, "acks.json"), "utf8"));
    assert.equal(acks[0].accepted, true); assert.equal(acks[1].accepted, false);
    assert.match(acks[1].error, /queue for main is full/i); assert.equal(acks[1].mailId, undefined);
    assert.equal(f.broker.mailStore.countPendingJobs(), 2);
    assert.equal(f.broker.mailStore.queued(f.broker.mainAddress).length, 1);
    await assert.rejects(send(f.broker, '{"tag":"third"}'), /queue for main is full/i);
    await f.broker.stop(first.envelope.to);
    const stopped = await terminal(f.broker, first.envelope.id);
    assert.equal(stopped.result, "forced_stop"); assert.equal(f.broker.mailStore.countPendingJobs(), 1);
    await f.broker.mailStore.compact(); f.config.maxQueuedMessages = restoredLimit; await f.reopen();
    assert.equal(f.broker.mailStore.getJob(second.envelope.id)?.phase, "queued");
    assert.equal(f.broker.mailStore.countPendingJobs(), 1);
    await assert.rejects(send(f.broker, '{"tag":"third"}'), /queue for main is full/i);
    await f.broker.restart(first.envelope.to);
    const completed = await terminal(f.broker, second.envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    assert.equal(completed.result, "success"); assert.equal(f.broker.mailStore.countPendingJobs(), 0);
    const queued = f.broker.mailStore.queued(f.broker.mainAddress);
    assert.equal(queued.length, 3); assert.equal(queued[0]?.priority, "high");
    assert.deepEqual(new Set(queued.map((mail) => mail.id)), new Set([acks[0].mailId, stopped.outcomeMailId, completed.outcomeMailId]));
    assert.equal(await exists(join(f.root, "main.jsonl")), false, "busy main was not steered by uncorrelated notifications");
    f.setMainIdle(true); await f.broker.flushQueuedMainMail(); await f.reopen();
    const presented = (await readFile(join(f.root, "main.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(presented.length, 3); assert.equal(new Set(presented.map((mail) => mail.id)).size, 3);
    assert.equal(await readFile(join(f.root, "starts"), "utf8"), "first\nsecond\n");
  } finally { await f.close(); }
});

it("ordinary Python notifications cannot consume bytes reserved for their automatic outcome", async () => {
  const f = await fixture("import json,time\nfrom pathlib import Path\nfrom pi_mechanistic import *\na=[send_email(invocation()['mainAddress'],'x','x'*n) for n in [60,80]]\nPath('acks.tmp').write_text(json.dumps(a)); Path('acks.tmp').replace('acks.json')\nwhile not Path('finish').exists(): time.sleep(.01)\nsuccess('small')\n", { maxQueuedMessages: 4, maxQueuedBytes: 700, maxMessageBytes: 512, maxSubjectBytes: 64 });
  try {
    f.setMainIdle(false);
    const accepted = await send(f.broker); await file(join(f.root, "acks.json"));
    const acks = JSON.parse(await readFile(join(f.root, "acks.json"), "utf8"));
    assert.equal(acks[0].accepted, true); assert.equal(acks[1].accepted, false);
    assert.match(acks[1].error, /queue for main is full/i);
    await assert.rejects(send(f.broker), /queue for main is full/i);
    await writeFile(join(f.root, "finish"), "");
    const job = await terminal(f.broker, accepted.envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    assert.equal(job.result, "success");
    const queued = f.broker.mailStore.queued(f.broker.mainAddress);
    assert.equal(queued.length, 2);
    assert.ok(queued.reduce((sum, mail) => sum + Buffer.byteLength(mail.subject) + Buffer.byteLength(mail.message), 0) <= 700);
    assert.equal(f.broker.mailStore.get(job.outcomeMailId!)?.message, outcomeText(job));
    f.setMainIdle(true); await f.broker.flushQueuedMainMail();
    assert.equal(f.broker.mailStore.get(job.outcomeMailId!)?.deliveryState, "delivered");
  } finally { await f.close(); }
});

it("unreportable mail limits reject a Python invocation before durable acceptance or execution", async () => {
  const f = await fixture("from pathlib import Path\nPath('must-not-run').touch()\n", { maxMessageBytes: 64 });
  try {
    await assert.rejects(send(f.broker), /Message exceeds 64 bytes/);
    assert.equal(f.broker.mailStore.listJobs().length, 0); assert.equal(f.broker.mailStore.list().length, 0);
    assert.equal(f.broker.getSnapshot().capacity.identitiesUsed, 0);
    assert.equal(await exists(join(f.root, "must-not-run")), false);
  } finally { await f.close(); }
});

for (const reduced of ["maxBatchBytes", "maxMessageBytes"] as const) it(`restoration never injects an older queued outcome beyond current ${reduced}`, async () => {
  const f = await fixture("from pi_mechanistic import success\nsuccess('x'*4096)\n");
  try {
    f.setMainIdle(false);
    const job = await terminal(f.broker, (await send(f.broker)).envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    const outcome = f.broker.mailStore.get(job.outcomeMailId!)!;
    assert.equal(outcome.deliveryState, "queued");
    f.config[reduced] = 1024; // A real restart with reduced limits.
    f.setMainIdle(true); await f.reopen();
    assert.equal(f.broker.mailStore.get(outcome.id)?.deliveryState, "failed");
    assert.match(f.broker.mailStore.get(outcome.id)?.error ?? "", reduced === "maxBatchBytes" ? /context-safe envelope limit/ : /Message exceeds 1024 bytes/);
    assert.equal(f.broker.mailStore.getJob(job.id)?.outcomeMailId, outcome.id);
    assert.deepEqual(f.broker.mailStore.getJob(job.id)?.reported, job.reported);
    assert.equal(await exists(join(f.root, "main.jsonl")), false);
    assert.equal(f.broker.mailStore.listJobs().length, 1);
  } finally { await f.close(); }
});

for (const crash of [false, true]) it(`line-heavy reports are projected without changing ${crash ? "crash precedence" : "success"}`, async () => {
  const f = await fixture(`from pathlib import Path\nfrom pi_mechanistic import success\nPath('status.txt').write_text('ready')\nsuccess('x'+'\\n'*4095,['status.txt'])\n${crash ? "raise SystemExit(7)" : ""}\n`);
  try {
    const job = await terminal(f.broker, (await send(f.broker)).envelope.id);
    await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
    assert.equal(job.result, crash ? "crash" : "success"); assert.equal(job.exitCode, crash ? 7 : 0);
    assert.equal(job.reported?.status, "success"); assert.equal(job.reported.summary, `x${"\n".repeat(4095)}`);
    assert.deepEqual(job.reported.artifacts, ["status.txt"]);
    const outcome = f.broker.mailStore.get(job.outcomeMailId!)!;
    assert.match(outcome.message, /summary shortened or omitted/);
    assert.ok(outcome.message.includes(`Runtime: ${job.result}. Script report: success.`));
    assert.ok(formatEmail(outcome).split("\n").length <= MAIL_TOOL_BATCH_LINES);
    assert.equal(outcome.deliveryState, "delivered");
  } finally { await f.close(); }
});

for (const selection of ["absolute", "relative", "PATH"]) it(`real virtualenv imports survive ${selection} Python registration and restore`, async () => {
  const f = await fixture("import json,sys\nfrom pi_mechanistic import success, invocation\nfrom mechanistic_venv_only import VALUE\nwith open('starts','a') as s: s.write(invocation()['jobId']+'\\n')\nsuccess(json.dumps(dict(prefix=sys.prefix,basePrefix=sys.base_prefix,executable=sys.executable,value=VALUE)))\n");
  try {
    const { execFileSync } = await import("node:child_process");
    const venv = join(f.root, "venv"); const python = join(venv, "bin/python");
    execFileSync("python3", ["-m", "venv", "--without-pip", venv]);
    const site = execFileSync(python, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { encoding: "utf8" }).trim();
    await writeFile(join(site, "mechanistic_venv_only.py"), "VALUE = 'module exists only inside this virtualenv'\n");
    execFileSync("python3", ["-c", "import importlib.util; assert importlib.util.find_spec('mechanistic_venv_only') is None"], { cwd: f.root });
    const previousPath = process.env.PATH;
    try {
      if (selection === "PATH") process.env.PATH = `${join(venv, "bin")}:${previousPath ?? ""}`;
      f.config.mechanisticPrograms = mergeMechanisticPrograms({}, { worker: {
        python: selection === "PATH" ? "python" : selection === "relative" ? "venv/bin/python" : python,
        script: join(f.root, "job.py"), cwd: f.root,
      } }, f.root);
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
    const ids: string[] = [];
    for (let run = 0; run < 2; run++) {
      const job = await terminal(f.broker, (await send(f.broker)).envelope.id);
      await until(() => f.broker.getSnapshot().capacity.runSlotsUsed === 0);
      assert.equal(job.result, "success", JSON.stringify(job));
      assert.equal(job.binding.python, python); assert.equal(f.config.mechanisticPrograms.worker?.python, python);
      const observed = JSON.parse(job.reported!.summary);
      assert.equal(observed.prefix, venv); assert.notEqual(observed.basePrefix, venv);
      assert.equal(observed.executable, python); assert.equal(observed.value, "module exists only inside this virtualenv");
      ids.push(job.id);
      await f.reopen();
      assert.equal(f.broker.mailStore.getJob(job.id)?.binding.python, python);
    }
    assert.deepEqual((await readFile(join(f.root, "starts"), "utf8")).trim().split("\n"), ids, "restoring the invocation path never replays accepted work");
  } finally { await f.close(); }
});
