import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiRpcClient } from "../test/e2e/helpers/rpc-client.ts";
import { MailStore, parseMailEvent } from "../src/mail-store.ts";
const exec = promisify(execFile);
const output = ".test-workspaces/mechanistic-ux";
const repo = "metzzo/pi-email-subagent";
const commit = "17febc848812eedf91b79ed550050c1b4aba0dea";
async function main(): Promise<number> {
  const artifact = join(output, "live-mechanistic-ci-latest.json");
  await mkdir(output, { recursive: true });
  if (process.env.LIVE_GITHUB_CI !== "1") {
    await writeFile(
      artifact,
      JSON.stringify({ phase: "opt-in", errorClass: "not-enabled" }),
    );
    return 2;
  }
  try {
    await exec("gh", ["auth", "status", "--hostname", "github.com"], {
      timeout: 20_000,
    });
  } catch {
    await writeFile(
      artifact,
      JSON.stringify({
        phase: "preflight",
        errorClass: "github-auth-unavailable",
      }),
    );
    return 2;
  }
  const root = await mkdtemp(join(tmpdir(), "ci-gh-"));
  let client: PiRpcClient | undefined;
  let result = 1;
  try {
    const checkout = join(root, "checkout");
    await exec("git", ["clone", "--no-hardlinks", process.cwd(), checkout], {
      timeout: 30_000,
    });
    await exec("git", ["-C", checkout, "checkout", "--detach", commit]);
    await exec("git", [
      "-C",
      checkout,
      "remote",
      "set-url",
      "origin",
      `https://github.com/${repo}.git`,
    ]);
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "subagents.json"),
      JSON.stringify({
        lifecycle: { runTimeoutMs: 60_000 },
        mechanisticPrograms: {
          ci: {
            python: "python3",
            script: resolve("src/python/examples/github_ci.py"),
            cwd: checkout,
            description: "Read-only GitHub Actions observation",
            inputExamples: ["{}"],
          },
        },
      }),
    );
    client = PiRpcClient.launch({
      cwd: checkout,
      agentDir: agent,
      model: "openai/gpt-4.1-nano",
      extensions: [
        resolve("src/index.ts"),
        resolve("test/e2e/helpers/provider-request-observer-extension.ts"),
      ],
      approveProject: true,
      env: {
        OPENAI_API_KEY: "deterministic-unused",
        PI_OFFLINE: "1",
        TMPDIR: root,
      },
    });
    const state = await client.getState();
    const sessionId = (state.data as { sessionId?: string }).sessionId;
    if (!sessionId) throw new Error("missing session");
    const models = await client.getAvailableModels();
    if (
      !(
        (models.data as { models?: Array<{ provider?: string; id?: string }> })
          .models ?? []
      ).some((m) => m.provider === "openai" && m.id === "gpt-4.1-nano")
    )
      throw new Error("model unavailable");
    const mark = client.mark();
    await client.prompt(`/agents run ci.main-status {}`);
    const acceptance = await client.waitFor(
      (l) =>
        l.type === "message_end" &&
        (l.message as { customType?: string }).customType ===
          "pi-email-subagent.command",
      "acceptance",
      30_000,
      mark,
    );
    const details = (
      acceptance.message as { details?: { jobId?: string; address?: string } }
    ).details;
    if (!details?.jobId || details.address !== "ci.main-status@mechanistic.com")
      throw new Error("invalid acceptance");
    await client.waitFor(
      (l) =>
        l.type === "message_end" &&
        (l.message as { customType?: string }).customType ===
          "pi-email-subagent.email",
      "outcome",
      90_000,
      mark,
    );
    if (
      client
        .events()
        .some((event) =>
          ["agent_start", "agent_end", "agent_settled"].includes(event.type),
        )
    )
      throw new Error("agent lifecycle observed");
    await client.close();
    const close = await client.waitForClose();
    if (close.code !== 0 || close.signal !== null)
      throw new Error("physical close failure");
    const journal = join(agent, "subagents", sessionId, "mail.jsonl");
    const store = new MailStore(journal);
    await store.init();
    const events = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => parseMailEvent(JSON.parse(line)));
    const terminal = events.find((event) => event.type === "job.terminal");
    if (!terminal || !("job" in terminal))
      throw new Error("missing terminal job");
    const job = store.getJob(terminal.job.id);
    if (
      !job ||
      job.id !== details.jobId ||
      job.result !== "success" ||
      job.triggerTurn !== false ||
      job.outcomeDeliveryState !== "delivered" ||
      job.cleanup?.state !== "confirmed" ||
      job.cleanup.childExited !== true ||
      job.cleanup.pipesClosed !== true ||
      store.countPendingJobs() !== 0
    )
      throw new Error("job did not settle successfully");
    const summary = job.reported?.summary ?? "";
    if (
      !summary.includes(repo) ||
      !summary.includes(commit) ||
      !summary.includes(
        "Observation completed; this is not a claim that CI passed.",
      )
    )
      throw new Error("report summary mismatch");
    const links = (job.reported?.artifacts ?? []).map((link) => new URL(link));
    if (
      links.length === 0 ||
      links.length > 8 ||
      links.some(
        (link) =>
          link.protocol !== "https:" ||
          link.hostname !== "github.com" ||
          !/^\/metzzo\/pi-email-subagent\/(actions\/runs\/[1-9][0-9]*|commit\/[0-9a-f]+\/checks)$/.test(
            link.pathname,
          ),
      )
    )
      throw new Error("invalid bounded GitHub link");
    if (
      (await readFile(join(checkout, ".provider-requests")).catch(() => "")) !==
      ""
    )
      throw new Error("provider request observed");
    result = 0;
    await writeFile(
      artifact,
      JSON.stringify(
        {
          repository: repo,
          commit,
          jobId: job.id,
          outcomeId: job.outcomeMailId,
          observation: "completed",
          ciPassed: "not-asserted",
          cleanup: job.cleanup,
          physicalClose: close,
          providerRequests: 0,
          agentLifecycle: 0,
          pendingJobs: store.countPendingJobs(),
          triggerTurn: false,
          links: links.map((link) => link.pathname),
          partial: summary.includes("Partial observation"),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      artifact,
      JSON.stringify({
        repository: repo,
        commit,
        phase: "observation",
        errorClass: error instanceof Error ? "assertion-failure" : "unknown",
      }),
    );
  } finally {
    if (client) await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  console.log(artifact);
  return result;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.exitCode = 1;
  });
