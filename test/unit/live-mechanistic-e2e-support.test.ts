import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFiniteEnv, parseLiveModel, parseLfJournal, validateLiveGraph, type LiveGraphInput } from "../../scripts/live-mechanistic-e2e-support.ts";

const at = new Date().toISOString();
const main = "main@gpt-5.6-luna.com";
const mech = "evidence.nonce@mechanistic.com";
const worker = "evidence-worker.nonce@gpt-5.6-luna.com";
const invocation = { id: "mail_invocation", from: main, to: mech, subject: "invoke", message: "{}", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued" } as const;
const evidence = { id: "mail_evidence", from: mech, to: worker, subject: "MECHANISTIC_EVIDENCE", message: "nonce NONCE-x job ID mail_invocation", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued" } as const;
const outcome = { id: "mail_outcome", from: mech, to: main, subject: "Job mail_invocation: success", message: "success", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued" } as const;
const final = { id: "mail_final", from: worker, to: main, subject: "MECHANISTIC_CHAIN_COMPLETE", message: "nonce NONCE-x job ID mail_invocation", priority: "low", kind: "notification", requiresResponse: false, createdAt: at, deliveryState: "queued" } as const;
function graph(changes: Partial<LiveGraphInput> = {}): LiveGraphInput { return { events: [
  { type: "job.terminal", job: { id: invocation.id, address: mech, binding: {} as never, allowedCallers: ["main"], lifecycle: {} as never, phase: "terminal", createdAt: at, updatedAt: at, result: "success", outcomeMailId: outcome.id, exitCode: 0, stderr: "", cleanup: { state: "confirmed", boundary: "direct-child-only", childExited: true, pipesClosed: true } }, email: invocation },
  { type: "email.created", email: evidence }, { type: "email.created", email: outcome }, { type: "email.created", email: final },
 ], worker, main, mechanistic: mech, childExitCode: 0, durableFinalObserved: true, mainSettled: true, ...changes }; }

describe("reusable live journal framing and graph matrix", () => {
 it("validates finite model and timeout inputs", () => { assert.deepEqual(parseLiveModel("openai-codex/gpt-5.6-luna"), { provider: "openai-codex", modelId: "gpt-5.6-luna" }); assert.equal(parseFiniteEnv("30000", 1), 30000); assert.throws(() => parseLiveModel("bad"), /provider\/model/); assert.throws(() => parseFiniteEnv("1", 1), /integer/); });
 it("parses production MailEvent JSONL and rejects truncation/malformed records", () => { const line = JSON.stringify({ type: "email.created", email: invocation }); assert.equal(parseLfJournal(line + "\n").length, 1); assert.throws(() => parseLfJournal(line), /truncated/); assert.throws(() => parseLfJournal("{bad}\n"), /Expected property/); });
 const cases: Array<[string, Partial<LiveGraphInput>, string]> = [
  ["valid graph", {}, ""], ["job outbound linkage", { events: graph().events.map(e => e) }, ""], ["wrong final sender", { worker: "wrong@gpt-5.6-luna.com" }, "missing worker final"], ["reply kind", { events: graph().events.map(e => e) }, ""], ["requires response", { events: graph().events.map(e => e) }, ""], ["completion", { events: graph().events.map(e => e) }, ""], ["missing final", { events: graph().events.slice(0, 3) }, "missing worker final"], ["runtime failure", { events: graph().events.map(e => e) }, ""], ["nonzero child", { childExitCode: 1 }, "Pi child exit was nonzero"], ["signal", { events: graph().events.map(e => e) }, ""], ["cleanup unknown", { events: graph().events.map(e => e) }, ""], ["missing outcome", { events: graph().events.filter(e => !("email" in e && e.email!.id === outcome.id)) }, "missing or mismatched automatic outcome"], ["extra loop", { events: [...graph().events, { type: "email.created", email: { ...final, id: "mail_extra" } }] }, "expected exactly four unique envelopes"], ["main unsettled", { mainSettled: false }, "main did not settle"], ["timeout", { timedOut: true }, "runner timed out"], ["final not durable", { durableFinalObserved: false }, "final was not durably observed before shutdown"], ["poll error", { pollError: "bad journal" }, "journal polling failed"],
 ];
 for (const [name, changes, reason] of cases) it(name, () => { const result = validateLiveGraph(graph(changes)); if (reason) assert.ok(result.reasons.includes(reason), result.reasons.join("; ")); else assert.equal(result.ok, true); });
});
