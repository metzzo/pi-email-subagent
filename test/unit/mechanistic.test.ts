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
    assert.doesNotMatch(mechanisticPrompt(trusted, "llm"), /command\.<task-slug>|inspect_agent shows/);
    assert.match(mechanisticPrompt(trusted, "llm"), /ask main for input examples/);
    assert.match(mechanisticPrompt(trusted, "main"), /inspect_agent shows examples/);
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

it("program descriptions and JSON examples are bounded trusted discovery, not binding authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanistic-description-"));
  try {
    await writeFile(join(root, "job.py"), "raise RuntimeError('must not run during discovery')\n");
    const binding = { python: "python3", script: "job.py", cwd: root };
    const registration = (extra: Record<string, unknown>) => mergeMechanisticPrograms({}, { observer: { ...binding, ...extra } }, root).observer!;
    const description = "é".repeat(128); const example = JSON.stringify({ x: "x".repeat(1016) });
    assert.equal(Buffer.byteLength(example), 1024);
    const valid = registration({ description, inputExamples: [example, "{}", '{"commit":"main"}'] });
    assert.equal(valid.description, description); assert.deepEqual(valid.inputExamples, [example, "{}", '{"commit":"main"}']);
    const utf8Example = JSON.stringify({ x: "é".repeat(508) });
    assert.equal(Buffer.byteLength(utf8Example), 1024);
    assert.deepEqual(registration({ inputExamples: [utf8Example] }).inputExamples, [utf8Example]);
    assert.equal(Object.hasOwn(parseMechanisticBinding(valid), "description"), false);
    for (const value of [null, "", " ", 1, "é".repeat(129), "line\nbreak", "\u001b[0m", "bidi\u202e"]) assert.throws(() => registration({ description: value }), /description/);
    for (const value of [null, {}, [1], ["{}", "{}", "{}", "{}"], [JSON.stringify({ x: "x".repeat(1017) })], [JSON.stringify({ x: "é".repeat(509) })]]) assert.throws(() => registration({ inputExamples: value }), /example/);
    for (const value of ["", " ", "[]", "null", '"text"', "1", "-0", "1e309", "true", "false", "bad", "{", '{"x":}', '{"x":1,}', '{"x":NaN}', '{"x":Infinity}']) assert.throws(() => registration({ inputExamples: [value] }), /encode a JSON object/);
    assert.deepEqual(registration({ inputExamples: [] }).inputExamples, []);
    const pretty = ' \n\t{\r\n "text" : "a  b", "escaped": "\\n\\t\\u0001"\r\n} ';
    for (const value of [pretty, '{\n}', '\t{}', '{}\r']) assert.throws(() => registration({ inputExamples: [value] }), /safe single-line/);
    for (const character of [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x7f + i)), "\u061c", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202e", "\u2066", "\u2069"]) {
      assert.throws(() => registration({ inputExamples: [`{"text":"${character}"}`] }), /example/i);
      assert.throws(() => registration({ inputExamples: [`{"text":"${character}","text":"safe"}`] }), /example/i, "unsafe source text cannot disappear behind a duplicate key");
    }
    for (const value of ['{"text":"\\u0001"}', '{"text":"\\u007f"}', '{"text":"\\u0085"}', '{"text":"\\u202e"}', '{"text":"\\u2066"}', '{"text":"\\u2028"}']) assert.deepEqual(registration({ inputExamples: [value] }).inputExamples, [value], "visible literal escapes must not be decoded for display");
    const compactNumbers = '{"values":[' + Array(50).fill("1e20").join(",") + ']}';
    assert.ok(Buffer.byteLength(compactNumbers) < 1024);
    assert.deepEqual(registration({ inputExamples: [compactNumbers] }).inputExamples, [compactNumbers], "stored/displayed text has the same byte bound; numbers are not expanded");
    assert.throws(() => registration({ inputExamples: [" ".repeat(1023) + "{}"] }), /example/i, "raw input bound remains enforced");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("safe single-line JSON examples survive trusted config loading byte-for-byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanistic-exact-example-"));
  try {
    await writeFile(join(root, "job.py"), "raise RuntimeError('discovery must not execute')\n");
    const examples = ['{"id":9007199254740993,"zero":-0,"large":1e309}', '  { "note" : "a  b\\nline\\tend", "escaped" : "\\u0061", "zero":-0.0e+00 }  ', '{"exponent":1E+003,"duplicate":1,"duplicate":2}'];
    await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { observer: { python: "python3", script: "job.py", inputExamples: examples } } }));
    assert.deepEqual(loadConfig(root, root, false).config.mechanisticPrograms.observer!.inputExamples, examples);
    assert.throws(() => mergeMechanisticPrograms({}, { observer: { python: "python3", script: "job.py", inputExamples: ['{"PRIVATE_EXAMPLE_TEXT":}'] } }, root), (error: unknown) => error instanceof Error && Buffer.byteLength(error.message) < 128 && !error.message.includes("PRIVATE_EXAMPLE_TEXT"));
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
