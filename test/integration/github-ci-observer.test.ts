import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import type { MainDelivery } from "../../src/types.ts";

// Local HTTP fixture, not GitHub: only remote responses are substituted.
// The observer, git, gh's Unix-socket transport, Python helper and broker are real.
it("local HTTP fixture exercises real git/gh observer counts, prioritized links and read-only requests without model calls", { timeout: 45000 }, async (t) => {
  // Keep the Unix-socket path short even when the host's TMPDIR is long.
  const root = await mkdtemp("/tmp/gh-unix-");
  const transportEnv = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH"] as const;
  const envKeys = ["GH_HOST", "GH_TOKEN", "GH_REPO", "GH_CONFIG_DIR", "GH_PROMPT_DISABLED", "TMPDIR", ...transportEnv] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let broker: AgentBroker | undefined;
  const requests: Array<{ method: string; url: string; host: string | undefined; body: string }> = [];
  let runs: Array<Record<string, unknown>> = []; let total = 0; let denied = false; let malformed = false; let commit = "";
  const command = (args: string[]) => { const value = spawnSync(args[0]!, args.slice(1), { cwd: root, encoding: "utf8", timeout: 10000 }); assert.equal(value.status, 0, `${args[0]}: ${value.stderr}`); return value.stdout.trim(); };
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method!, url: request.url!, host: request.headers.host, body });
    response.setHeader("content-type", "application/json");
    if (denied) { response.statusCode = 403; response.end(JSON.stringify({ message: "PRIVATE_RESPONSE_MUST_NOT_LEAK" })); return; }
    if (request.url?.includes("graphql")) response.end(JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", name: "repo", owner: { login: "owner" }, id: "R_fixture" } } }));
    else if (request.url?.includes("/commits/")) response.end(JSON.stringify({ sha: commit }));
    else response.end(malformed ? '{"invalid":' : JSON.stringify({ total_count: total, workflow_runs: runs }));
  });
  const abort = () => { server.closeAllConnections(); server.close(); void broker?.shutdown().catch(() => undefined); };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    for (const key of transportEnv) delete process.env[key];
    Object.assign(process.env, { GH_HOST: "github.com", GH_TOKEN: "local-test-only", GH_CONFIG_DIR: root, GH_PROMPT_DISABLED: "1", TMPDIR: root });
    delete process.env.GH_REPO;
    const socket = join(root, "gh.sock");
    await writeFile(join(root, "config.yml"), `http_unix_socket: ${JSON.stringify(socket)}\n`, { mode: 0o600 });
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socket, resolveListen); });
    command(["git", "init", "-q"]); command(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "observer fixture"]);
    commit = command(["git", "rev-parse", "HEAD"]);
    command(["git", "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    const config = structuredClone(DEFAULT_CONFIG); config.lifecycle.runTimeoutMs = 20000;
    config.mechanisticPrograms = mergeMechanisticPrograms({}, { ci: { python: "python3", script: resolve("src/python/examples/github_ci.py"), cwd: root } }, root);
    const delivered: MainDelivery[] = [];
    broker = new AgentBroker({ cwd: root, agentDir: root, namespaceDir: join(root, "state"), config, models: [], projectTrusted: true,
      workerFactory: () => { throw new Error("CI observer must not create a model worker"); },
      mainAdapter: { getAddress: () => "main@test.com", getAliases: () => new Set(["main@test.com"]), isIdle: () => true, async deliver(value) { delivered.push(value); }, notifyFailure(message) { throw new Error(message); }, updateState() {} } });
    await broker.init();
    const observe = async (message = "{}") => {
      const sent = await broker!.send(broker!.mainAddress, { to: "ci.main-status@mechanistic.com", subject: "CI observation", message, priority: "low" }, undefined, undefined, { triggerTurn: false });
      const end = Date.now() + 10000;
      while (!broker!.inspectMechanisticJob(sent.envelope.id).settled) { if (Date.now() > end) throw new Error(JSON.stringify(broker!.mailStore.getJob(sent.envelope.id))); await new Promise((r) => setTimeout(r, 10)); }
      return broker!.mailStore.getJob(sent.envelope.id)!;
    };
    runs = [{ id: 123, head_sha: commit, status: "completed", conclusion: "failure" }, { id: 124, head_sha: commit, status: "in_progress", conclusion: null }, { id: 125, head_sha: commit, status: "completed", conclusion: "success" }]; total = 3;
    let job = await observe();
    if (job.result !== "success") {
      const diagnostic = await promisify(execFile)("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: root, env: process.env, timeout: 10000 }).catch((error) => ({ stdout: error.stdout, stderr: error.stderr }));
      console.log(JSON.stringify({ requests, diagnostic }));
    }
    assert.equal(job.result, "success", JSON.stringify(job));
    assert.match(job.reported!.summary, /1 failed, 1 pending, 1 passed/); assert.ok(job.reported!.summary.includes(commit));
    assert.match(job.reported!.summary, /not a claim that CI passed/); assert.equal(job.reported!.artifacts[0], "https://github.com/owner/repo/actions/runs/123");
    const explicit = await observe('{"repository":"owner/repo","commit":"feature/topic"}');
    assert.equal(explicit.result, "success", JSON.stringify(explicit));
    assert.ok(requests.some((request) => request.url.includes("/commits/feature%2Ftopic")));
    runs = []; total = 0; job = await observe(); assert.equal(job.result, "success"); assert.match(job.reported!.summary, /no runs found/);
    runs = [{ id: 123, head_sha: commit, status: "completed", conclusion: "neutral" }]; total = 101;
    job = await observe(); assert.equal(job.result, "success"); assert.match(job.reported!.summary, /1 other.*Partial observation: showing 1 of 101/s);
    const run = (id: number, status: string, conclusion: string | null) => ({ id, head_sha: commit, status, conclusion });
    runs = [...Array.from({ length: 9 }, (_, index) => run(index + 1, "completed", "success")), run(50, "completed", "neutral"), run(70, "queued", null), run(90, "completed", "failure"), run(51, "completed", "cancelled"), run(91, "completed", "timed_out"), run(71, "waiting", null)]; total = 20;
    const beforePriority = requests.length; job = await observe();
    assert.equal(job.result, "success"); assert.match(job.reported!.summary, /2 failed, 2 pending, 9 passed, 2 other/);
    assert.match(job.reported!.summary, /Partial observation: showing 15 of 20 runs/);
    assert.match(job.reported!.summary, /not a claim that CI passed/);
    assert.deepEqual(job.reported!.artifacts, [90, 91, 70, 71, 1, 2, 3, 4].map((id) => `https://github.com/owner/repo/actions/runs/${id}`));
    assert.equal(job.reported!.summary.split("\n")[2], job.reported!.artifacts[0], "failure beyond API position eight is the leading link");
    assert.equal(requests.length - beforePriority, 2, "prioritization needs only the existing repository and runs reads");
    runs = [run(50, "completed", "neutral"), run(1, "completed", "success"), run(70, "queued", null), run(2, "completed", "success"), run(51, "completed", "cancelled")]; total = runs.length;
    job = await observe(); assert.deepEqual(job.reported!.artifacts, [70, 1, 2, 50, 51].map((id) => `https://github.com/owner/repo/actions/runs/${id}`));
    runs = Array.from({ length: 10 }, (_, index) => run(90 + index, "completed", "failure")); total = runs.length;
    job = await observe(); assert.match(job.reported!.summary, /10 failed/);
    assert.deepEqual(job.reported!.artifacts, Array.from({ length: 8 }, (_, index) => `https://github.com/owner/repo/actions/runs/${90 + index}`));
    const before = requests.length;
    for (const input of ['{"repository":"--evil"}', '{"commit":"-n"}', '{"commit":"HEAD;touch owned"}', '{"repository":"owner/../repo"}', '{"notify_to":"worker.task@test.com"}']) {
      assert.equal((await observe(input)).result, "invalid_arguments");
    }
    assert.equal(requests.length, before, "invalid input is rejected before any GitHub request, after job acceptance");
    denied = true; job = await observe('{"repository":"owner/repo"}');
    assert.equal(job.result, "task_failure"); assert.doesNotMatch(JSON.stringify(job), /PRIVATE_RESPONSE_MUST_NOT_LEAK|local-test-only/);
    denied = false; malformed = true; assert.equal((await observe('{"repository":"owner/repo"}')).result, "task_failure"); malformed = false;
    runs = [{ id: 1, head_sha: "0".repeat(40), status: "completed", conclusion: "success" }]; total = 1;
    assert.equal((await observe('{"repository":"owner/repo"}')).result, "task_failure");
    assert.ok(requests.every((request) => request.host === "api.github.com" || request.host === "github.com"));
    assert.ok(requests.every((request) => request.method === "GET" || request.method === "POST" && request.url.includes("graphql") && !/\bmutation\b/.test(request.body)));
    assert.ok(requests.some((request) => request.url.includes(`head_sha=${commit}`)));
    assert.ok(delivered.every((delivery) => delivery.triggerTurn === false));
    assert.equal(broker.mailStore.list().length, delivered.length * 2, "CI program emits only one automatic outcome per job, no explicit email");
    console.log(JSON.stringify({ fixture: "local HTTP Unix socket, not GitHub", jobs: broker.mailStore.listJobs().length, requests: requests.length }));
  } finally {
    t.signal.removeEventListener("abort", abort);
    await broker?.shutdown();
    server.closeAllConnections(); await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
});
