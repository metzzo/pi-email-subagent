import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface PackedFile { path: string }
interface PackResult { filename: string; files: PackedFile[] }

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
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "src/index.ts"]) {
    assert.equal(paths.has(required), true, `packed artifact is missing ${required}`);
  }
  assert.equal([...paths].some((path) => path.startsWith("test/")), false, "tests must not ship in the package");

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

  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
  assert.equal(settings.packages?.length, 1, "package install was not persisted in the isolated agent directory");
  console.log(`package smoke passed: ${pack.files.length} files, /agents loaded from packed artifact`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
