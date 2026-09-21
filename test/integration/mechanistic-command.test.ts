import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { MailStore } from "../../src/mail-store.ts";
import { PiRpcClient } from "../e2e/helpers/rpc-client.ts";

const extension = resolve("src/index.ts"); const provider = resolve("test/helpers/mechanistic-ux-provider.ts");
const bin = resolve("node_modules/.bin/pi");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "python-command-")); const agent = join(root, "agent"); await mkdir(agent);
  const script = join(root, "status.py");
  await writeFile(script, "from pi_mechanistic import *\nimport time\ndef main(args):\n progress('observing actual file',20)\n time.sleep(args.get('delay', .15))\n if args.get('large'): success('OBSERVATION_FINISHED '+'é'*2000, ['é'*1024]*29)\n else: (failure if args.get('fail') else success)('OBSERVATION_FINISHED', ['https://example.test/ci'])\nrun(main)\n");
  await writeFile(join(agent, "subagents.json"), JSON.stringify({ lifecycle: { runTimeoutMs: 3000, abortTimeoutMs: 100, disposeTimeoutMs: 100 }, mechanisticPrograms: { ci: { python: "python3", script, cwd: root, description: "Observe CI without dispatch", inputExamples: ['{}'] } } }));
  return { root, agent, env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent, UX_MODEL_CALLS: join(root, "model-calls"), TMPDIR: root } };
}
async function journal(agent: string) {
  const namespaces = await readdir(join(agent, "subagents"));
  const directory = namespaces.find((name) => !name.includes("."))!;
  const path = join(agent, "subagents", directory, "mail.jsonl");
  // Never let a diagnostic MailStore repair the live owner's journal.
  const snapshot = join(agent, "mail-observation.jsonl");
  await writeFile(snapshot, await readFile(path));
  const store = new MailStore(snapshot); await store.init(); return store;
}

for (const mode of ["print", "json", "print-large"] as const) it(`real Pi ${mode} command awaits Python terminal/delivery/cleanup and outputs without a model`, { timeout: 30000 }, async (t) => {
  const f = await fixture();
  const child = spawn(bin, ["-ne", "-e", provider, "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--model", "ux-local/ux-local", ...(mode === "json" ? ["--mode", "json"] : ["-p"]), `/agents run ci.main-status ${mode === "print-large" ? '{"large":true}' : '{}'}`], { cwd: f.root, env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => { stdout += data; });
  const delayedRead = mode === "print-large" ? setTimeout(() => child.stdout.resume(), 2500) : undefined;
  if (delayedRead) child.stdout.pause();
  child.stderr.on("data", (data: string) => { stderr += data; });
  const kill = () => { child.kill("SIGKILL"); }; t.signal.addEventListener("abort", kill, { once: true });
  const deadline = setTimeout(kill, 20000);
  try {
    const exit = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    console.log(JSON.stringify({ mode, stdoutBytes: Buffer.byteLength(stdout), stderr }));
    assert.equal(exit, 0, stderr); assert.equal(existsSync(f.env.UX_MODEL_CALLS), false, stdout);
    assert.match(stdout, /Python job accepted/); assert.match(stdout, /OBSERVATION_FINISHED/);
    if (mode === "json") {
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.some((event) => ["agent_start", "agent_end", "agent_settled"].includes(event.type)), false);
      assert.equal(events.filter((event) => event.type === "message_end" && event.message.customType === "pi-email-subagent.email").length, 1);
    }
    const store = await journal(f.agent); const job = store.listJobs()[0]!;
    assert.equal(job.result, "success"); assert.equal(job.cleanup?.state, "confirmed"); assert.equal(job.outcomeDeliveryState, "delivered");
    assert.equal(job.triggerTurn, false); assert.equal(store.get(job.outcomeMailId!)?.triggerTurn, false);
    // Pi itself currently defers a fresh session file until an assistant turn.
    const sessions = await readdir(join(f.agent, "sessions"), { recursive: true }).catch(() => []);
    assert.equal(sessions.some((name) => String(name).endsWith(".jsonl")), false);
  } finally { clearTimeout(deadline); clearTimeout(delayedRead); t.signal.removeEventListener("abort", kill); kill(); await rm(f.root, { recursive: true, force: true }); }
});

it("real RPC command discovery, invalid JSON and script failure need no agent_settled or model generation", { timeout: 30000 }, async (t) => {
  const f = await fixture();
  const client = PiRpcClient.launch({ cwd: f.root, agentDir: f.agent, model: "ux-local/ux-local", extensions: [provider, extension], piBin: bin, env: f.env });
  const kill = () => { client.kill("SIGKILL"); }; t.signal.addEventListener("abort", kill, { once: true });
  try {
    for (const [command, expected] of [["/agents programs", /Observe CI without dispatch/], ["/agents program ci", /Input example/], ['/agents run ci.fail {"fail":true}', /Runtime: task_failure/], ["/agents run ci.invalid not-json", /Runtime: invalid_arguments/], ["/agents run unknown.test {}", /Unknown or removed/], ["/agents run worker.test@ux-local.com {}", /registered Python programs only/]]) {
      const mark = client.mark(); await client.prompt(command as string);
      const shown = await client.waitFor((line) => line.type === "message_end" && (expected as RegExp).test(JSON.stringify(line.message)), "direct command output", 10000, mark);
      if (command === "/agents program ci") {
        const text = (shown.message as { content: string }).content;
        const example = /^Input example: (.*)$/m.exec(text)?.[1];
        assert.equal(example, "{}", "displayed JSON is directly copyable, not a quoted JSON string");
        await client.prompt(`/agents run ci.copied ${example}`);
      }
    }
    assert.equal(existsSync(f.env.UX_MODEL_CALLS), false); assert.equal(client.events().some((line) => line.type === "agent_start"), false);
    const store = await journal(f.agent); assert.equal(store.listJobs().length, 3);
    assert.equal(store.listJobs().find((job) => job.address === "ci.copied@mechanistic.com")?.result, "success");
    assert.ok(store.listJobs().every((job) => job.phase === "terminal" && job.outcomeDeliveryState === "delivered" && job.triggerTurn === false));
  } finally {
    const deadline = setTimeout(kill, 5000); try { assert.equal(await client.close(), 0); } finally { clearTimeout(deadline); t.signal.removeEventListener("abort", kill); kill(); await rm(f.root, { recursive: true, force: true }); }
  }
});

it("a failing command observer cannot throw into publication or fail unrelated accepted Python work", { timeout: 20000 }, async (t) => {
  const f = await fixture(); const failure = join(f.root, "observer-failure");
  const client = PiRpcClient.launch({ cwd: f.root, agentDir: f.agent, model: "ux-local/ux-local", extensions: [provider, resolve("test/helpers/mechanistic-ux-stall-extension.ts")], piBin: bin, env: { ...f.env, UX_OBSERVATION_FAILURE: failure } });
  const kill = () => { client.kill("SIGKILL"); }; t.signal.addEventListener("abort", kill, { once: true });
  try {
    client.send({ type: "prompt", message: '/agents run ci.observer {"delay":1.2}' });
    const receipt = await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("Python job accepted"), "observed acceptance", 10000);
    const id = (receipt.message as { details: { jobId: string } }).details.jobId;
    await writeFile(failure, "fail only command observation");
    await client.prompt("/agents run ci.sibling {}");
    const failed = await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("command observation failed"), "isolated observer failure", 3000);
    assert.match(JSON.stringify(failed.message), new RegExp(`${id}.*do not resend or replay`));
    await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("OBSERVATION_FINISHED") && JSON.stringify(line.message).includes(id), "original work continues safely", 5000);
    const jobs = (await journal(f.agent)).listJobs();
    assert.equal(jobs.length, 2); assert.ok(jobs.every((job) => job.result === "success" && job.cleanup?.state === "confirmed" && job.outcomeDeliveryState === "delivered"));
    assert.equal(existsSync(f.env.UX_MODEL_CALLS), false);
  } catch (error) {
    console.log(JSON.stringify({ observerFaultJobs: (await journal(f.agent)).listJobs().map((job) => ({ id: job.id, address: job.address, phase: job.phase, result: job.result, cleanup: job.cleanup })) }));
    throw error;
  } finally {
    await rm(failure, { force: true }); const deadline = setTimeout(kill, 5000);
    try { assert.equal(await client.close(), 0); } finally { clearTimeout(deadline); t.signal.removeEventListener("abort", kill); kill(); await rm(f.root, { recursive: true, force: true }); }
  }
});

it("headless command deadline is finite while exact committed finalization authority is stalled", { timeout: 85000 }, async (t) => {
  const f = await fixture(); const release = join(f.root, "release-finalization"); const held = join(f.root, "held-finalization");
  const configPath = join(f.agent, "subagents.json"); const config = JSON.parse(await readFile(configPath, "utf8"));
  config.lifecycle = { spawnTimeoutMs: 500, runTimeoutMs: 1000, abortTimeoutMs: 50, disposeTimeoutMs: 50 };
  await writeFile(configPath, JSON.stringify(config));
  const client = PiRpcClient.launch({ cwd: f.root, agentDir: f.agent, model: "ux-local/ux-local", extensions: [provider, resolve("test/helpers/mechanistic-ux-stall-extension.ts")], piBin: bin, env: { ...f.env, UX_FINALIZATION_RELEASE: release, UX_FINALIZATION_HELD: held } });
  const kill = () => { client.kill("SIGKILL"); }; t.signal.addEventListener("abort", kill, { once: true });
  try {
    const started = Date.now(); client.send({ type: "prompt", message: "/agents run ci.stall {}" });
    await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("command deadline expired"), "finite exact-job command deadline", 75000);
    assert.ok(Date.now() - started < 75000);
    const id = await readFile(held, "utf8"); const stalled = (await journal(f.agent)).getJob(id)!;
    assert.equal(stalled.phase, "terminal"); assert.equal(stalled.result, "success"); assert.equal(stalled.outcomeDeliveryState, "queued");
    assert.equal(existsSync(f.env.UX_MODEL_CALLS), false);
    await writeFile(release, "release committed callback");
    await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("OBSERVATION_FINISHED"), "settled direct outcome", 10000);
    assert.equal(existsSync(f.env.UX_MODEL_CALLS), false);
    assert.equal((await journal(f.agent)).getJob(id)!.outcomeMailId, stalled.outcomeMailId);
  } finally {
    await writeFile(release, "cleanup"); const deadline = setTimeout(kill, 5000);
    try { assert.equal(await client.close(), 0); } finally { clearTimeout(deadline); t.signal.removeEventListener("abort", kill); kill(); await rm(f.root, { recursive: true, force: true }); }
  }
});

it("a real busy main finishes its explicit turn then receives direct outcome without another model call", { timeout: 30000 }, async (t) => {
  const f = await fixture(); const release = join(f.root, "release");
  const client = PiRpcClient.launch({ cwd: f.root, agentDir: f.agent, model: "ux-local/ux-local", extensions: [provider, extension], piBin: bin, env: { ...f.env, UX_RELEASE_FILE: release } });
  const kill = () => { client.kill("SIGKILL"); }; t.signal.addEventListener("abort", kill, { once: true });
  try {
    await client.prompt("A deliberate user turn"); await client.waitFor((line) => line.type === "agent_start", "explicit busy main", 10000);
    const command = client.prompt("/agents run ci.busy {}");
    // Pi defers triggerTurn:false custom receipts while streaming. Observe a
    // copy of the real journal instead of expecting a premature UI event.
    const end = Date.now() + 10000;
    while ((await journal(f.agent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }))?.listJobs()[0]?.phase !== "terminal") {
      if (Date.now() >= end) throw new Error("Direct busy-main job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const store = await journal(f.agent); assert.equal(store.listJobs()[0]!.outcomeDeliveryState, "queued");
    await writeFile(release, "finish explicit turn"); await command;
    await client.waitFor((line) => line.type === "message_end" && JSON.stringify(line.message).includes("OBSERVATION_FINISHED"), "deferred outcome", 10000);
    assert.equal(await readFile(f.env.UX_MODEL_CALLS, "utf8"), "generation\n");
    assert.equal((await journal(f.agent)).listJobs()[0]!.outcomeDeliveryState, "delivered");
  } finally {
    await writeFile(release, "cleanup"); const deadline = setTimeout(kill, 5000);
    try { assert.equal(await client.close(), 0); } finally { clearTimeout(deadline); t.signal.removeEventListener("abort", kill); kill(); await rm(f.root, { recursive: true, force: true }); }
  }
});
