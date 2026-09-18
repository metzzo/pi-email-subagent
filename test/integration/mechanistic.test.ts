import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
