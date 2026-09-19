import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { PiRpcClient } from "./helpers/rpc-client.ts";

it("fresh Pi classifies real Python protocol failures, reports and bounded progress", { timeout: 40_000 }, async () => {
  const cases = [
    ["success", "from pi_mechanistic import success\nsuccess('done')", "success"],
    ["failure", "from pi_mechanistic import failure\nfailure('failed task')", "task_failure"],
    ["arguments", "from pi_mechanistic import run, InvalidArguments\ndef invalid(a): raise InvalidArguments('invalid operation')\nrun(invalid)", "invalid_arguments"],
    ["crash", "from pi_mechanistic import success\nsuccess('reported')\nraise SystemExit(7)", "crash"],
    ["missing", "pass", "missing_terminal"],
    ["timeout", "import time\ntime.sleep(5)", "timeout"],
    ["invalid", "print('invalid-json',flush=True)", "protocol_failure"],
    ["truncated", "import os\nos.write(1,b'{}')", "protocol_failure"],
    ["oversized", "print('x'*65537,flush=True)", "protocol_failure"],
    ["unknown-field", "print('{\"v\":1,\"id\":1,\"op\":\"progress\",\"message\":\"hi\",\"reply_to\":\"forbidden\"}',flush=True)", "protocol_failure"],
    ["unknown-id", "print('{\"v\":1,\"id\":4,\"op\":\"success\",\"summary\":\"done\"}',flush=True)", "protocol_failure"],
    ["after-terminal", "print('{\"v\":1,\"id\":1,\"op\":\"success\",\"summary\":\"done\"}\\n{\"v\":1,\"id\":2,\"op\":\"progress\",\"message\":\"late\"}',flush=True)", "protocol_failure"],
    ["invalid-priority", "print('{\"v\":1,\"id\":1,\"op\":\"send_email\",\"to\":\"main@mock-e2e.com\",\"subject\":\"s\",\"message\":\"m\",\"priority\":\"urgent\"}',flush=True)", "protocol_failure"],
    ["invalid-fields", "print('{\"v\":1,\"id\":1,\"op\":\"send_email\",\"to\":17}',flush=True)", "protocol_failure"],
    ["rejected-send", "from pi_mechanistic import *\na=send_email('unknown.job@mechanistic.com','subject','{}')\nassert not a['accepted'] and not a['ok']\nsuccess('rejected without retry')", "success"],
    ["ack-pressure", "import json\nfor i in range(1,5000): print(json.dumps(dict(v=1,id=i,op='progress',message='tick')),flush=True)", "protocol_failure"],
    ["progress", "from pi_mechanistic import *\nimport time,sys\nfor i in range(5):\n progress('tick '+str(i),i*20)\n time.sleep(.06)\nsys.stderr.write('x'*100000+'tail')\nsuccess('progress done')", "success"],
  ] as const;
  const root = await mkdtemp(join(tmpdir(), "python-protocol-pi-")); const script = join(root, "job.py"); const proof = join(root, "proof.json");
  await writeFile(script, `import json\nfrom pi_mechanistic import arguments\nCASES=json.loads(${JSON.stringify(JSON.stringify(Object.fromEntries(cases.map(([name, code]) => [name, code]))))})\nexec(CASES[arguments()['case']])\n`);
  await writeFile(join(root, "subagents.json"), JSON.stringify({ lifecycle: { runTimeoutMs: 800, abortTimeoutMs: 50, disposeTimeoutMs: 50 }, mechanisticPrograms: { monitor: { python: "python3", script, cwd: root } } }));
  const client = PiRpcClient.launch({ cwd: root, agentDir: root, model: "mock-e2e/mock-e2e", extensions: [resolve("test/e2e/helpers/mock-provider-extension.ts"), resolve("test/e2e/helpers/mechanistic-probe-extension.ts")], env: { PI_MECHANISTIC_CASES: JSON.stringify(cases.map(([name, , result]) => [name, result])), PI_MECHANISTIC_PROOF: proof } });
  try {
    await client.getState(); await client.prompt("/mechanistic-matrix");
    const result = JSON.parse(await readFile(proof, "utf8")); assert.equal(result.jobs.length, cases.length);
    assert.equal(new Set(result.jobs.map((job: { id: string }) => job.id)).size, cases.length);
    assert.equal(result.abandoned.result, "abandoned"); assert.equal(result.abandoned.generation, undefined); assert.ok(result.abandoned.outcomeMailId);
    assert.match(result.jobs.at(-1).progress.message, /tick/); assert.ok(result.jobs.at(-1).stderr.endsWith("tail"));
  } finally { await client.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
