import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { MailStore } from "../../src/mail-store.ts";
import type { MechanisticJob } from "../../src/types.ts";
import { PiRpcClient } from "./helpers/rpc-client.ts";

const extensions = [resolve("test/e2e/helpers/mock-provider-extension.ts"), resolve("test/e2e/helpers/mechanistic-probe-extension.ts")];
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try { const value = await read(); if (value !== undefined) return value; } catch { /* wait for real evidence */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("No durable mechanistic crash/restore evidence within deadline");
}
it("fresh Pi executes the real Python tool path and renders honest script inspection/dashboard/results", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "python-host-view-")); const proof = join(root, "proof.json");
  await writeFile(join(root, "status.txt"), "ready\n");
  await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { monitor: { python: "python3", script: resolve("src/python/examples/status_file.py"), cwd: root } } }));
  const client = PiRpcClient.launch({ cwd: root, agentDir: root, model: "mock-e2e/mock-e2e", extensions, env: { PI_MECHANISTIC_PROOF: proof } });
  try {
    await client.getState(); await client.prompt("/mechanistic-run");
    const result = JSON.parse(await readFile(proof, "utf8"));
    assert.equal(result.job.result, "success"); assert.equal(result.inspection.kind, "mechanistic");
    assert.match(result.rendered, /confirmed/); assert.ok(result.rendered.includes(result.job.id));
    assert.equal(result.snapshot.agents[0].state, "idle", "a settled empty Python queue must not be displayed as queued");
  } finally { await client.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

for (const boundary of ["accepted", "starting", "running", "effect", "terminal"] as const) {
  it(`real Pi owner loss after ${boundary} preserves one accepted ID and never replays a start claim`, { timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `python-owner-${boundary}-`));
    const marker = join(root, "marker.json"); const proof = join(root, "proof.json");
    const script = join(root, "job.py");
    await writeFile(script, `from pi_mechanistic import run, success\nfrom pathlib import Path\nimport os,time,json\ndef main(args):\n with open('effects','a') as f: f.write('once\\n')\n if ${boundary === "effect" ? "True" : "False"}:\n  Path('effect.json').write_text(json.dumps({'pid':os.getpid()}))\n  time.sleep(.5)\n success('done')\nrun(main)\n`);
    await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { monitor: { python: "python3", script, cwd: root } } }));
    const client = PiRpcClient.launch({ cwd: root, agentDir: root, model: "mock-e2e/mock-e2e", extensions, persistSession: true, env: { PI_MECHANISTIC_BOUNDARY: boundary, PI_MECHANISTIC_MARKER: marker } });
    let restored: PiRpcClient | undefined;
    try {
      const mark = client.mark();
      await client.prompt("E2E PING"); await client.waitForSettlement(mark);
      const state = (await client.getState()).data as { sessionId: string; sessionFile: string };
      await readFile(state.sessionFile, "utf8");
      assert.ok(state.sessionFile); assert.ok(state.sessionId);
      const pending = client.prompt("/mechanistic-run"); void pending.catch(() => undefined);
      const journal = join(root, "subagents", state.sessionId, "mail.jsonl");
      const before = await eventually(async () => {
        await readFile(boundary === "effect" ? join(root, "effect.json") : marker, "utf8");
        const store = new MailStore(journal); await store.init(); return store.listJobs()[0];
      });
      assert.equal(client.kill("SIGKILL"), true); await client.waitForExit();
      // The deliberately interrupted child is finite and receives EOF when the
      // owner dies. Do not leave a test-created orphan running during restore.
      await new Promise((r) => setTimeout(r, 650));
      restored = PiRpcClient.launch({ cwd: root, agentDir: root, model: "mock-e2e/mock-e2e", extensions, persistSession: true, session: state.sessionFile, env: { PI_MECHANISTIC_PROOF: proof } });
      const restoredState = (await restored.getState()).data as { sessionId: string };
      assert.equal(restoredState.sessionId, state.sessionId, "resume the exact persisted session/namespace");
      if (boundary === "accepted") {
        await eventually(async () => { const store = new MailStore(journal); await store.init(); return store.getJob(before.id)?.phase === "terminal" ? true : undefined; });
      }
      await restored.prompt("/mechanistic-inspect"); await restored.waitForExit();
      const result = JSON.parse(await readFile(proof, "utf8")) as { jobs: MechanisticJob[]; mail: { id: string; kind: string; inReplyTo?: string }[] };
      assert.equal(result.jobs.length, 1); const after = result.jobs[0]!; assert.equal(after.id, before.id);
      assert.equal(after.phase, "terminal"); assert.ok(after.outcomeMailId);
      assert.equal(result.mail.filter((mail) => mail.id === after.outcomeMailId).length, 1);
      assert.equal(result.mail.find((mail) => mail.id === after.outcomeMailId)?.kind, "notification");
      assert.equal(result.mail.find((mail) => mail.id === after.outcomeMailId)?.inReplyTo, undefined);
      const effects = await readFile(join(root, "effects"), "utf8").catch(() => "");
      if (boundary === "accepted" || boundary === "terminal") { assert.equal(after.result, "success"); assert.equal(effects, "once\n"); }
      else {
        assert.equal(after.result, "interrupted"); assert.equal(after.cleanup?.state, "cleanup-unknown");
        assert.equal(effects, boundary === "effect" ? "once\n" : "");
      }
      if (boundary === "terminal") assert.equal(after.outcomeMailId, before.outcomeMailId, "restore reuses the durable outcome ID");
    } finally {
      client.kill("SIGKILL"); await client.waitForExit().catch(() => undefined);
      restored?.kill("SIGKILL"); await restored?.waitForExit().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
}
