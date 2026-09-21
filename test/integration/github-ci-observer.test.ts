import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:https";
import { connect, createServer as createProxy, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { mergeMechanisticPrograms } from "../../src/mechanistic.ts";
import type { MainDelivery } from "../../src/types.ts";

// Only GitHub's remote response is substituted. The observer, git repository,
// gh executable/TLS transport, Python helper, broker and durable jobs are real.
it("packaged observer uses real git/gh read-only requests, exact commits and bounded observations without model calls", { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "github-observer-"));
  const envKeys = ["GH_HOST", "GH_TOKEN", "GH_REPO", "SSL_CERT_FILE", "GH_CONFIG_DIR", "GH_PROMPT_DISABLED", "TMPDIR", "HTTPS_PROXY", "NO_PROXY"] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let broker: AgentBroker | undefined;
  const requests: Array<{ method: string; url: string; body: string }> = [];
  let runs: Array<Record<string, unknown>> = []; let total = 0; let denied = false; let malformed = false;
  const key = join(root, "key.pem"); const cert = join(root, "cert.pem");
  const command = (args: string[]) => { const value = spawnSync(args[0]!, args.slice(1), { cwd: root, encoding: "utf8", timeout: 10000 }); assert.equal(value.status, 0, `${args[0]}: ${value.stderr}`); return value.stdout.trim(); };
  command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=api.github.com", "-addext", "subjectAltName=DNS:api.github.com,DNS:github.com"]);
  command(["git", "init", "-q"]); command(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "observer fixture"]);
  const commit = command(["git", "rev-parse", "HEAD"]);
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method!, url: request.url!, body });
    response.setHeader("content-type", "application/json");
    if (denied) { response.statusCode = 403; response.end(JSON.stringify({ message: "PRIVATE_RESPONSE_MUST_NOT_LEAK" })); return; }
    if (request.url?.includes("graphql")) response.end(JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", name: "repo", owner: { login: "owner" }, id: "R_fixture" } } }));
    else if (request.url?.includes("/commits/")) response.end(JSON.stringify({ sha: commit }));
    else response.end(malformed ? '{"invalid":' : JSON.stringify({ total_count: total, workflow_runs: runs }));
  });
  const sockets = new Set<Socket>();
  const proxy = createProxy((client) => {
    sockets.add(client); client.on("close", () => sockets.delete(client)); client.on("error", () => client.destroy());
    client.once("data", (request) => {
      assert.match(request.toString(), /^CONNECT (?:api\.)?github\.com:443 HTTP\/1\.[01]/);
      const upstream = connect((server.address() as { port: number }).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); client.pipe(upstream); upstream.pipe(client);
      });
      sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream)); upstream.on("error", () => client.destroy()); client.on("close", () => upstream.destroy());
    });
  });
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    await new Promise<void>((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
    const port = (proxy.address() as { port: number }).port;
    Object.assign(process.env, { GH_HOST: "github.com", GH_TOKEN: "local-test-only", SSL_CERT_FILE: cert, GH_CONFIG_DIR: root, GH_PROMPT_DISABLED: "1", TMPDIR: root, HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "" });
    delete process.env.GH_REPO;
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
    assert.ok(requests.every((request) => request.method === "GET" || request.method === "POST" && request.url.includes("graphql") && !/\bmutation\b/.test(request.body)));
    assert.ok(requests.some((request) => request.url.includes(`head_sha=${commit}`)));
    assert.ok(delivered.every((delivery) => delivery.triggerTurn === false));
    assert.equal(broker.mailStore.list().length, delivered.length * 2, "CI program emits only one automatic outcome per job, no explicit email");
    await writeFile(join(root, "request-evidence.json"), JSON.stringify(requests));
  } finally {
    await broker?.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
    server.closeAllConnections(); await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
});
