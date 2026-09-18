import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../../src/index.ts";
import { AgentBroker } from "../../../src/broker.ts";
import { MailStore } from "../../../src/mail-store.ts";
import type { EmailEnvelope, MechanisticJob, SendEmailResult } from "../../../src/types.ts";
import { DashboardComponent } from "../../../src/ui.ts";

// Instrument only real commit boundaries; no broker/process behavior is faked.
const boundary = process.env.PI_MECHANISTIC_BOUNDARY;
const marker = process.env.PI_MECHANISTIC_MARKER;
let broker: AgentBroker | undefined;
function hold(phase: string, job: MechanisticJob): Promise<void> {
  if (boundary !== phase || !marker) return Promise.resolve();
  writeFileSync(marker, JSON.stringify({ phase, job, pid: process.pid }));
  return new Promise(() => undefined);
}
const init = AgentBroker.prototype.init;
AgentBroker.prototype.init = async function () { await init.call(this); broker = this; };
const accept = MailStore.prototype.acceptJob;
MailStore.prototype.acceptJob = async function (email: EmailEnvelope, job: MechanisticJob) {
  await accept.call(this, email, job); await hold("accepted", job);
};
const update = MailStore.prototype.updateJob;
MailStore.prototype.updateJob = async function (job: MechanisticJob) {
  await update.call(this, job);
  if (job.phase === "starting" || job.phase === "running") await hold(job.phase, job);
};
const finish = MailStore.prototype.finishJob;
MailStore.prototype.finishJob = async function (job: MechanisticJob, mail: EmailEnvelope) {
  await finish.call(this, job, mail); await hold("terminal", job);
};

export default function mechanisticProbe(pi: ExtensionAPI): void {
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  extension(new Proxy(pi, { get(target, key, receiver) {
    if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => { tools.set(tool.name, tool); target.registerTool(tool); };
    const value = Reflect.get(target, key, receiver); return typeof value === "function" ? value.bind(target) : value;
  } }));
  pi.registerCommand("mechanistic-run", {
    description: "Exercise one real registered Python job and persist exact evidence",
    handler: async (_args, ctx) => {
      assert.ok(broker, "production broker initialized");
      const sendTool = tools.get("send_email")!;
      const sent = await sendTool.execute("probe-send", {
        to: "monitor.probe@mechanistic.com", subject: "Observe installed local input", message: '{"expected":"ready","attempts":2}', priority: "low",
      }, undefined, undefined, ctx);
      const accepted = (sent.details as { result: SendEmailResult }).result;
      assert.ok(accepted?.envelope, JSON.stringify(sent));
      const end = Date.now() + 15_000;
      while (broker.mailStore.getJob(accepted.envelope.id)?.phase !== "terminal" || broker.getSnapshot().capacity.runSlotsUsed !== 0) {
        if (Date.now() >= end) throw new Error("Python probe did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const job = broker.mailStore.getJob(accepted.envelope.id)!;
      assert.equal(job.result, "success"); assert.equal(job.cleanup?.state, "confirmed");
      assert.equal(job.id, accepted.envelope.id);
      const outcome = broker.mailStore.get(job.outcomeMailId!)!;
      assert.equal(outcome.kind, "notification"); assert.equal(outcome.inReplyTo, undefined); assert.equal(outcome.requiresResponse, false);
      await broker.mailStore.compact();
      assert.equal(broker.mailStore.getJob(job.id)?.outcomeMailId, job.outcomeMailId);
      const inspection = broker.inspectAgent(accepted.envelope.to);
      assert.equal(inspection.kind, "mechanistic");
      for (const key of ["modelId", "provider", "effort", "usage", "sessionFile", "work", "pendingReplies", "unanswered"]) assert.equal(Object.hasOwn(inspection, key), false, key);
      const inspectionTool = tools.get("inspect_agent")!;
      const inspected = await inspectionTool.execute("probe-inspect", { address: accepted.envelope.to }, undefined, undefined, ctx);
      assert.match(JSON.stringify(inspected.content), /send-only|Python/i);
      const actions: unknown[] = [];
      const dashboard = new DashboardComponent(() => broker!.getSnapshot(), (address) => broker!.fetchUnanswered(address), (action) => actions.push(action), () => {}, ctx.ui.theme, accepted.envelope.to, undefined, 80, (address) => broker!.inspectAgent(address));
      let rendered: string;
      try {
        dashboard.handleInput("\r"); rendered = dashboard.render(200).join("\n");
        assert.match(rendered, /Python|python/); assert.ok(rendered.includes(job.id)); assert.match(rendered, /confirmed/);
        for (const key of ["i", "m", "\x0f"]) dashboard.handleInput(key);
        assert.deepEqual(actions, [], "no inbox, effort or conversation action exists for Python");
        assert.match(dashboard.render(200).join("\n"), /no conversation, inbox, or effort/);
      } finally { dashboard.dispose(); }
      const sendRendered = sendTool.renderResult!(sent, { expanded: true, isPartial: false }, ctx.ui.theme, {} as never).render(200).join("\n");
      assert.match(sendRendered, /Python|python/); assert.doesNotMatch(sendRendered, /Conversation preview|thinking|tokens/);
      if (process.env.PI_MECHANISTIC_PROOF) writeFileSync(process.env.PI_MECHANISTIC_PROOF, JSON.stringify({ accepted, job, outcome, inspection, rendered, sendRendered, snapshot: broker.getSnapshot() }));
      ctx.shutdown();
    },
  });
  pi.registerCommand("mechanistic-inspect", {
    description: "Persist restored production job evidence without replaying an invocation",
    handler: async (_args, ctx) => {
      assert.ok(broker);
      if (process.env.PI_MECHANISTIC_PROOF) writeFileSync(process.env.PI_MECHANISTIC_PROOF, JSON.stringify({ jobs: broker.mailStore.listJobs(), mail: broker.mailStore.list(), snapshot: broker.getSnapshot() }));
      ctx.shutdown();
    },
  });
}
