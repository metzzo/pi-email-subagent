import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPackageMarkdownLinks, assertPackageSurface, type PackResult } from "./package-policy.ts";
import { SUPPORTED_PI_VERSION } from "../src/pi-compat.ts";
import { PiRpcClient } from "../test/e2e/helpers/rpc-client.ts";

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
  assert.equal(hostVersion, SUPPORTED_PI_VERSION, "packed smoke must use the exact tested Pi host version");
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

  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
  assert.equal(settings.packages?.length, 1, "package install was not persisted in the isolated agent directory");
  console.log(`package smoke passed on supported Pi ${SUPPORTED_PI_VERSION}: ${pack.files.length} files, /agents loaded and real Python job ${proof.job.id} succeeded from packed artifact`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
