import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiRpcClient } from "../test/e2e/helpers/rpc-client.ts";
const exec = promisify(execFile);
const rootOut = ".test-workspaces/mechanistic-ux";
async function main(): Promise<number> {
  if (process.env.LIVE_GITHUB_CI !== "1") {
    console.error("set LIVE_GITHUB_CI=1 to opt in");
    return 2;
  }
  try {
    await exec("gh", ["auth", "status"], { timeout: 20_000 });
  } catch {
    console.error("GitHub prerequisite unavailable: authenticated gh required");
    return 2;
  }
  const root = await mkdtemp(join(tmpdir(), "ci-observe-"));
  const agent = join(root, "agent");
  await mkdir(agent, { recursive: true });
  await writeFile(
    join(agent, "subagents.json"),
    JSON.stringify({
      mechanisticPrograms: {
        ci: {
          python: "python3",
          script: resolve("src/python/examples/github_ci.py"),
          cwd: process.cwd(),
          description: "Read-only GitHub Actions observation",
          inputExamples: [
            '{"repository":"metzzo/pi-email-subagent","commit":"17febc848812eedf91b79ed550050c1b4aba0dea"}',
          ],
        },
      },
    }),
  );
  const client = PiRpcClient.launch({
    cwd: root,
    agentDir: agent,
    model: "openai/gpt-4.1-nano",
    extensions: [
      resolve("src/index.ts"),
      resolve("test/e2e/helpers/provider-request-observer-extension.ts"),
    ],
    approveProject: true,
    env: { OPENAI_API_KEY: "deterministic-unused", PI_OFFLINE: "1" },
  });
  let exit = 1;
  try {
    const models = await client.getAvailableModels();
    const available =
      (models.data as { models?: Array<{ provider?: string; id?: string }> })
        .models ?? [];
    if (
      !available.some((m) => m.provider === "openai" && m.id === "gpt-4.1-nano")
    )
      throw new Error("model unavailable");
    await client.prompt(
      '/agents run ci.main-status {"repository":"metzzo/pi-email-subagent","commit":"17febc848812eedf91b79ed550050c1b4aba0dea"}',
    );
    await client.close();
    const closed = await client.waitForClose();
    exit = closed.code === 0 && closed.signal === null ? 0 : 1;
  } catch {
    await client.close().catch(() => undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(rootOut, { recursive: true });
  await writeFile(
    join(rootOut, `live-mechanistic-ci-${Date.now()}.json`),
    JSON.stringify(
      {
        repository: "metzzo/pi-email-subagent",
        commit: "17febc848812eedf91b79ed550050c1b4aba0dea",
        observation: exit === 0 ? "completed" : "failed",
        runnerExitCode: exit,
      },
      null,
      2,
    ),
  );
  return exit;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.exitCode = 1;
  });
