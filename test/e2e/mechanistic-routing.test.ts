import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { AgentRecord, EmailEnvelope, MechanisticJob } from "../../src/types.ts";
import { PiRpcClient } from "./helpers/rpc-client.ts";

for (const allowed of [false, true]) {
  it(`local deterministic provider exercises ${allowed ? "authorized Python/result-loop routing" : "default main-only rejection"} through the real LLM send tool`, { timeout: 40_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "python-llm-route-")); const proof = join(root, "proof.json");
    const script = join(root, "job.py");
    await writeFile(join(root, "status.txt"), "ready\n");
    await writeFile(script, "from pi_mechanistic import *\nfrom pathlib import Path\nimport json\na=arguments()\nPath('input.json').write_text(json.dumps(invocation()))\nack=send_email(a['notify_to'],'MECHANISTIC_RESULT','job_id='+invocation()['jobId'])\nassert ack['accepted']\nsuccess('Script sent its observation')\n");
    await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { monitor: { python: "python3", script, cwd: root, ...(allowed ? { allowedCallers: ["llm"] } : {}) } } }));
    const client = PiRpcClient.launch({ cwd: root, agentDir: root, model: "mock-e2e/mock-e2e", extensions: [resolve("test/e2e/helpers/mock-provider-extension.ts"), resolve("test/e2e/helpers/mechanistic-probe-extension.ts")], env: { PI_MECHANISTIC_PROOF: proof, PI_MECHANISTIC_ROUTE_ALLOWED: allowed ? "1" : "0" } });
    try {
      await client.getState(); await client.prompt("/mechanistic-route");
      const result = JSON.parse(await readFile(proof, "utf8")) as { jobs: MechanisticJob[]; mail: EmailEnvelope[]; snapshot: { agents: AgentRecord[] } };
      const worker = result.snapshot.agents.find((record) => record.kind === "llm")!;
      assert.equal(worker.kind, "llm"); if (worker.kind !== "llm") throw new Error("missing LLM worker");
      const session = await readFile(worker.sessionFile!, "utf8");
      assert.match(session, /Nested response-required delegation is unsupported; agent scout\.e2e@mock-e2e\.com cannot send requests to subagents\./);
      assert.equal(result.mail.some((mail) => mail.to === "reviewer.e2e@mock-e2e.com"), false);
      assert.equal(result.jobs.length, allowed ? 1 : 0);
      if (!allowed) {
        assert.match(session, /does not authorize llm callers/);
        await assert.rejects(readFile(join(root, "input.json")), /ENOENT/);
      } else {
        const job = result.jobs[0]!; assert.equal(job.result, "success");
        const trigger = result.mail.find((mail) => mail.id === job.id)!;
        assert.equal(trigger.from, worker.address); assert.equal(trigger.kind, "notification"); assert.equal(trigger.requiresResponse, false);
        const observation = result.mail.find((mail) => mail.subject === "MECHANISTIC_RESULT")!;
        assert.equal(observation.from, job.address); assert.equal(observation.to, worker.address); assert.equal(observation.kind, "notification"); assert.equal(observation.inReplyTo, undefined);
        const followOn = result.mail.find((mail) => mail.subject === "MECHANISTIC_LOOP_COMPLETE")!;
        assert.equal(followOn.from, worker.address); assert.equal(followOn.to, "main@mock-e2e.com"); assert.ok(followOn.message.includes(job.id)); assert.equal(followOn.inReplyTo, undefined);
        assert.equal(result.mail.filter((mail) => mail.id === job.outcomeMailId).length, 1);
        const input = JSON.parse(await readFile(join(root, "input.json"), "utf8")); assert.equal(input.jobId, job.id);
        assert.ok(session.includes(job.id));
      }
      assert.equal(result.mail.some((mail) => mail.requiresResponse), false, "routing creates no hidden response obligations");
    } finally { await client.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
}
