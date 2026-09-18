import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.ts";
import { ModelCatalog, makeMainAddress } from "../../src/address.ts";
import { mergeMechanisticPrograms, parseMechanisticBinding, parseMechanisticCallers } from "../../src/mechanistic.ts";
import { parseJob, parseProgress, parseTerminal } from "../../src/mechanistic-job.ts";
import { parseRegistry } from "../../src/registry-store.ts";
import { MailStore, parseMailEvent } from "../../src/mail-store.ts";
import { mechanisticPrompt } from "../../src/prompts.ts";
import type { EmailEnvelope, MechanisticJob } from "../../src/types.ts";
import { mechanisticParserCases } from "../helpers/mechanistic-parser-cases.ts";

it("strict mechanistic contracts through the direct TypeScript loader", mechanisticParserCases);

it("trusted config resolves global/project path bases, defaults to main-only and rejects duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanistic-config-"));
  try {
    const agent = join(root, "agent"); const project = join(root, "project");
    await mkdir(agent); await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(agent, "global.py"), "raise RuntimeError('registration must not execute')\n");
    await writeFile(join(project, "project.py"), "raise RuntimeError('registration must not execute')\n");
    await writeFile(join(agent, "subagents.json"), JSON.stringify({ mechanisticPrograms: { " Command ": { python: "python3", script: "global.py" } } }));
    await writeFile(join(project, ".pi", "subagents.json"), JSON.stringify({ mechanisticPrograms: { monitor: { python: "python3", script: "project.py", allowedCallers: ["llm"] } } }));
    const untrusted = loadConfig(agent, project, false).config;
    assert.deepEqual(Object.keys(untrusted.mechanisticPrograms), ["command"]);
    assert.deepEqual(untrusted.mechanisticPrograms.command!.allowedCallers, ["main"]);
    assert.equal(untrusted.mechanisticPrograms.command!.script, join(agent, "global.py"));
    const trusted = loadConfig(agent, project, true).config;
    assert.equal(trusted.mechanisticPrograms.monitor!.cwd, project);
    assert.equal(trusted.mechanisticPrograms.monitor!.script, join(project, "project.py"));
    assert.match(mechanisticPrompt(trusted, "llm"), /monitor\.<task-slug>@mechanistic\.com/);
    assert.doesNotMatch(mechanisticPrompt(trusted, "llm"), /command\.<task-slug>/);
    await writeFile(join(project, ".pi", "subagents.json"), JSON.stringify({ mechanisticPrograms: { COMMAND: { python: "python3", script: "project.py" } } }));
    assert.throws(() => loadConfig(agent, project, true), /Duplicate/);
    assert.throws(() => mergeMechanisticPrograms({}, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`program-${i}`, {}])), root), /at most 32/);
    assert.throws(() => mergeMechanisticPrograms({}, { command: { python: "python3", script: "missing.py" } }, root));
    assert.throws(() => mergeMechanisticPrograms({}, { command: { python: "never-existent-python-command", script: "missing.py" } }, root), /not found/);
    assert.throws(() => mergeMechanisticPrograms({}, { command: { python: "python3", script: "global.py", shell: true } }, agent), /Unknown/);
    for (const value of [null, [], ["main", "main"], ["spoof"], ["main", "llm", "mechanistic", "main"]]) assert.throws(() => parseMechanisticCallers(value));
    assert.throws(() => parseMechanisticBinding({ key: "command", python: "relative", script: "/a", cwd: "/" }), /absolute/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reserved model/catalog/main/registry/model-intent collisions fail explicitly", () => {
  assert.throws(() => new ModelCatalog([{ id: "MeChanistic" } as never]), /reserved/);
  assert.throws(() => makeMainAddress("mechanistic"), /reserved/);
  const at = new Date().toISOString();
  const registry = { version: 1, mainAddress: "main@test.com", mainAliases: ["main@test.com"], updatedAt: at, agents: [{ kind: "llm", address: "worker.test@mechanistic.com", modelId: "mechanistic" }] };
  assert.throws(() => parseRegistry(registry), /reserved/);
  assert.throws(() => parseRegistry({ ...registry, agents: [], mainAliases: ["main@mechanistic.com"] }), /reserved/);
  assert.throws(() => parseMailEvent({ type: "email.created", email: { id: "mail_a", from: "main@test.com", to: "worker.test@mechanistic.com", subject: "test", message: "{}", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued", modelBindingIntent: { provider: "test", modelId: "mechanistic" } } }), /reserved/);
  assert.equal(parseRegistry({ ...registry, agents: [] }).version, 2);
});

it("progress, summary, artifacts, and durable job inputs are strictly bounded", () => {
  assert.deepEqual(parseProgress({ message: "latest", percent: 100 }), { message: "latest", percent: 100 });
  for (const percent of [-1, 101, NaN, Infinity, "1", null]) assert.throws(() => parseProgress({ message: "test", percent }));
  assert.throws(() => parseProgress({ message: "x".repeat(4097) }));
  for (const extra of [{ status: "other" }, { summary: "x".repeat(4097) }, { artifacts: Array(33).fill("x") }, { artifacts: ["x".repeat(2049)] }, { invalidArguments: true }]) {
    assert.throws(() => parseTerminal({ status: "success", summary: "done", ...extra }));
  }
  assert.equal(parseTerminal({ status: "failure", summary: "invalid", invalidArguments: true }).invalidArguments, true);
  assert.throws(() => parseJob({ phase: "unknown" }));
});

it("single-line durable jobs survive torn-tail restore, compaction, terminal idempotence and retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanistic-journal-"));
  try {
    const path = join(root, "mail.jsonl"); const store = new MailStore(path); await store.init();
    const at = new Date().toISOString(); const binding = { key: "worker", python: "/usr/bin/python3", script: "/tmp/job.py", cwd: "/tmp" };
    const email: EmailEnvelope = { id: "mail_job", from: "main@test.com", to: "worker.test@mechanistic.com", subject: "test", message: "{}", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued", mechanisticBindingIntent: binding };
    const job: MechanisticJob = { id: email.id, address: email.to, binding, allowedCallers: ["main"], lifecycle: { ...DEFAULT_CONFIG.lifecycle }, phase: "queued", createdAt: at, updatedAt: at, stderr: "" };
    await store.acceptJob(email, job);
    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1);
    assert.equal(store.getJob(job.id)!.phase, "queued");
    await store.updateJob({ ...job, phase: "starting", generation: 1 });
    assert.equal(store.get(email.id)!.deliveryState, "delivered");
    await assert.rejects(store.updateJob(job), /transition/);
    const running = { ...job, phase: "running" as const, generation: 1, pid: process.pid };
    await store.updateJob(running);
    await store.compact();
    const restored = new MailStore(path); await restored.init();
    assert.equal(restored.getJob(job.id)!.phase, "running");
    const terminal = { ...running, phase: "terminal" as const, result: "interrupted" as const, cleanup: { state: "cleanup-unknown" as const, childExited: false, pipesClosed: false, boundary: "direct-child-only" as const }, outcomeMailId: "mail_outcome" };
    const outcome: EmailEnvelope = { ...email, id: "mail_outcome", to: email.from, from: email.to, mechanisticBindingIntent: undefined };
    await restored.finishJob(terminal, outcome); await restored.finishJob(terminal, outcome);
    assert.equal(restored.list().length, 2);
    await restored.maintainIfNeeded(0, 1);
    const again = new MailStore(path); await again.init();
    assert.equal(again.list().length, 2); assert.equal(again.getJob(job.id)!.outcomeMailId, "mail_outcome");
    await assert.rejects(again.updateJob(running), /replay/);
    await writeFile(path, '{"type":"job.updated"', { flag: "a" });
    const torn = new MailStore(path); await torn.init(); assert.equal(torn.getJob(job.id)!.phase, "terminal");
  } finally { await rm(root, { recursive: true, force: true }); }
});
