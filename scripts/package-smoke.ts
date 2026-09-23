import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPackageMarkdownLinks, assertPackageSurface, type PackResult } from "./package-policy.ts";
import { PiRpcClient } from "../test/e2e/helpers/rpc-client.ts";
import { MailStore, parseMailEvent } from "../src/mail-store.ts";

const root = resolve(import.meta.dirname, "..");
const pi = join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const temp = await mkdtemp(join(tmpdir(), "pi-email-package-smoke-"));

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

try {
  const packed = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp]);
  const pack = (JSON.parse(packed.stdout) as PackResult[])[0];
  assert.ok(pack, "npm pack returned no package metadata");
  assertPackageSurface(pack);
  await assertPackageMarkdownLinks(pack, root);

  const consumer = join(temp, "consumer");
  const agentDir = join(temp, "agent");
  await mkdir(consumer, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  run("npm", ["init", "-y"], { cwd: consumer });
  const tarball = join(temp, pack.filename);
  run("npm", ["install", "--ignore-scripts", "--omit=peer", tarball], { cwd: consumer });

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const hostVersion = run(pi, ["--version"], { cwd: consumer, env }).stdout.trim();
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(hostVersion, pkg.devDependencies["@earendil-works/pi-coding-agent"], "packed smoke must use the development Pi baseline");
  const installedPackage = join(consumer, "node_modules", "pi-email-subagent");
  run(pi, ["install", installedPackage], { cwd: consumer, env });
  const rpc = run(pi, ["--mode", "rpc", "--no-session"], {
    cwd: consumer,
    env,
    input: `${JSON.stringify({ type: "get_commands", id: "package-smoke" })}\n`,
    timeout: 30_000,
  });
  const lines = rpc.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const response = lines.find((line) => line.id === "package-smoke" && line.type === "response") as {
    success?: boolean;
    data?: { commands?: Array<{ name?: string; sourceInfo?: { path?: string } }> };
  } | undefined;
  assert.equal(response?.success, true, `get_commands failed:\n${rpc.stdout}`);
  const agents = response?.data?.commands?.find((command) => command.name === "agents");
  assert.ok(agents, "packed extension did not register /agents");
  assert.match(agents.sourceInfo?.path ?? "", /pi-email-subagent[\\/]src[\\/]index\.ts$/);

  // A fresh Pi host, real broker, installed Python helper and installed safe
  // example. Only the existing local deterministic model fixture is used;
  // it supplies no Python/broker behavior and requires no paid credentials.
  const probePath = join(consumer, "mechanistic-probe.ts");
  const providerPath = join(consumer, "local-provider.ts");
  const proofPath = join(consumer, "python-proof.json");
  await writeFile(providerPath, await readFile(join(root, "test/e2e/helpers/mock-provider-extension.ts"), "utf8"));
  const probe = (await readFile(join(root, "test/e2e/helpers/mechanistic-probe-extension.ts"), "utf8"))
    .replaceAll("../../../src/", `${installedPackage}/src/`);
  await writeFile(probePath, probe);
  await writeFile(join(consumer, "status.txt"), "ready\n");
  const installedScript = join(installedPackage, "src/python/examples/status_file.py");
  await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ mechanisticPrograms: { monitor: { python: "python3", script: installedScript, cwd: consumer } } }));
  const pythonHost = PiRpcClient.launch({ piBin: pi, cwd: consumer, agentDir, model: "mock-e2e/mock-e2e", extensions: [providerPath, probePath], env: { PI_MECHANISTIC_PROOF: proofPath } });
  try {
    await pythonHost.getState();
    await pythonHost.prompt("/mechanistic-run");
    await readFile(proofPath, "utf8").catch((error) => { throw new Error(`Packed Python evidence missing: ${JSON.stringify(pythonHost.events())}\n${pythonHost.stderr}`, { cause: error }); });
  } finally { await pythonHost.close().catch(() => undefined); }
  const proof = JSON.parse(await readFile(proofPath, "utf8")) as { job: { id: string; result: string; binding: { script: string }; cleanup: { state: string } }; accepted: { envelope: { id: string }; recipientKind: string }; outcome: { inReplyTo?: string; kind: string } };
  assert.equal(proof.job.result, "success"); assert.equal(proof.job.cleanup.state, "confirmed");
  assert.equal(proof.job.binding.script, installedScript); assert.equal(proof.job.id, proof.accepted.envelope.id);
  assert.equal(proof.accepted.recipientKind, "mechanistic"); assert.equal(proof.outcome.kind, "notification"); assert.equal(proof.outcome.inReplyTo, undefined);

  let directJobId = "unknown";
  const observer = join(root, "test/e2e/helpers/provider-request-observer-extension.ts");
  const direct = PiRpcClient.launch({ piBin: pi, cwd: consumer, agentDir, model: "openai/gpt-4.1-nano", extensions: [observer], discoverExtensions: true, approveProject: true, env: { OPENAI_API_KEY: "deterministic-unused", PI_OFFLINE: "1" } });
  try {
    const state = await direct.getState(); assert.equal(state.success, true);
    const sessionId = (state.data as { sessionId?: string }).sessionId; assert.ok(sessionId);
    await direct.waitForAvailableModel("openai", "gpt-4.1-nano");
    const mark = direct.mark();
    await direct.prompt("/agents run monitor.package-smoke {}");
    const acceptance = await direct.waitFor((line) => line.type === "message_end" && (line.message as { customType?: string }).customType === "pi-email-subagent.command", "packed acceptance", 30_000, mark);
    const details = (acceptance.message as { details?: { jobId?: string; address?: string } }).details; assert.ok(details?.jobId); directJobId = details.jobId; assert.equal(details.address, "monitor.package-smoke@mechanistic.com");
    const outcome = await direct.waitFor((line) => line.type === "message_end" && (line.message as { customType?: string }).customType === "pi-email-subagent.email", "packed outcome", 60_000, mark);
    assert.equal((outcome.message as { details?: { triggerTurn?: boolean } }).details?.triggerTurn, false);
    assert.equal(direct.events().some((line) => ["agent_start", "agent_end", "agent_settled"].includes(line.type)), false);
    assert.equal(await readFile(join(consumer, ".provider-requests")).catch(() => ""), "");
    await direct.close(); const close = await direct.waitForClose(); assert.equal(close.code, 0); assert.equal(close.signal, null);
    const journal = join(agentDir, "subagents", sessionId, "mail.jsonl"); const store = new MailStore(journal); await store.init();
    const events = (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map((line) => parseMailEvent(JSON.parse(line))); const terminal = events.find((event) => event.type === "job.terminal"); assert.ok(terminal && "job" in terminal); const job = store.getJob(terminal.job.id); assert.ok(job);
    assert.equal(job.id, details.jobId); assert.equal(job.address, details.address); assert.equal(job.phase, "terminal"); assert.equal(job.result, "success"); assert.equal(job.binding.script, installedScript); assert.equal(job.outcomeDeliveryState, "delivered"); assert.equal(job.triggerTurn, false); assert.equal(job.cleanup?.state, "confirmed"); assert.equal(job.cleanup?.childExited, true); assert.equal(job.cleanup?.pipesClosed, true); assert.equal(store.countPendingJobs(), 0); assert.ok(job.pid); assert.throws(() => process.kill(job.pid!, 0), (error) => (error as NodeJS.ErrnoException).code === "ESRCH");
    assert.equal((outcome.message as { details?: { id?: string } }).details?.id, job.outcomeMailId);
  } finally { await direct.close().catch(() => undefined); }

  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
  assert.equal(settings.packages?.length, 1, "package install was not persisted in the isolated agent directory");
  console.log(`package smoke passed on Pi ${hostVersion}: ${pack.files.length} files, packed direct command passed with job ${directJobId}; old helper job ${proof.job.id} also succeeded`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
