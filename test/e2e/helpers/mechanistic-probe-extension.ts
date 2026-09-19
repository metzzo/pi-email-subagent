import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../../src/index.ts";
import { AgentBroker } from "../../../src/broker.ts";
import { MailStore } from "../../../src/mail-store.ts";
import type { EmailEnvelope, MechanisticJob, SendEmailResult } from "../../../src/types.ts";
import { ConversationComponent, ConversationSource, DashboardComponent, formatConversationPreview, formatConversationTranscript } from "../../../src/ui.ts";

// Instrument only real commit boundaries; no broker/process behavior is faked.
const boundary = process.env.PI_MECHANISTIC_BOUNDARY;
const marker = process.env.PI_MECHANISTIC_MARKER;
let broker: AgentBroker | undefined;
function hold(phase: string, job: MechanisticJob): Promise<void> {
  if ((boundary === "archived-accepted" ? phase !== "accepted" || !broker?.mailStore.listJobs().some((prior) => prior.phase === "terminal") : boundary !== phase) || !marker) return Promise.resolve();
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
      if (boundary === "archived-accepted") {
        const first = await broker.send(broker.mainAddress, { to: "monitor.probe@mechanistic.com", subject: "before archive", message: "{}", priority: "low" });
        const deadline = Date.now() + 10000;
        while (broker.mailStore.getJob(first.envelope.id)?.phase !== "terminal" || broker.getSnapshot().capacity.runSlotsUsed !== 0) {
          if (Date.now() > deadline) throw new Error("First real job did not settle before archive");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await broker.stop(first.envelope.to); await broker.archive(first.envelope.to);
        assert.equal(broker.inspectAgent(first.envelope.to).state, "archived");
      }
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
  pi.registerCommand("mechanistic-matrix", {
    description: "Exercise bounded real Python protocol/runtime outcomes through Pi",
    handler: async (_args, ctx) => {
      assert.ok(broker);
      const cases = JSON.parse(process.env.PI_MECHANISTIC_CASES!) as Array<[string, string]>;
      const jobs: MechanisticJob[] = [];
      for (const [name, expected] of cases) {
        const accepted = await broker.send(broker.mainAddress, { to: "monitor.matrix@mechanistic.com", subject: name, message: JSON.stringify({ case: name }), priority: "low" });
        const end = Date.now() + 8000;
        while (broker.mailStore.getJob(accepted.envelope.id)?.phase !== "terminal" || broker.getSnapshot().capacity.runSlotsUsed !== 0) {
          if (Date.now() >= end) throw new Error(`Protocol case ${name} did not settle`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const job: MechanisticJob = broker.mailStore.getJob(accepted.envelope.id)!;
        assert.equal(job.result, expected, JSON.stringify(job)); assert.equal(job.cleanup?.state, "confirmed"); jobs.push(job);
        const dashboard = new DashboardComponent(() => broker!.getSnapshot(), (address) => broker!.fetchUnanswered(address), () => {}, () => {}, ctx.ui.theme, accepted.envelope.to, undefined, 80, (address) => broker!.inspectAgent(address));
        try {
          dashboard.handleInput("\r");
          const rendered = dashboard.render(200).join("\n");
          assert.ok(rendered.includes(`Job ${job.id} · terminal · ${expected}`), rendered);
          if (job.progress) assert.match(rendered, /progress:/);
          if (!job.reported) assert.match(rendered, /script report: none/);
        } finally { dashboard.dispose(); }
      }
      const address = "monitor.matrix@mechanistic.com";
      await broker.stop(address);
      const queued = await broker.send(broker.mainAddress, { to: address, subject: "never start", message: "{}", priority: "low" });
      const reason = "User abandoned this queued scope.\n\u001b]52;c;untrusted\u0007";
      await tools.get("cancel_request")!.execute("abandon", { request_id: queued.envelope.id, reason }, undefined, undefined, ctx);
      const abandoned = broker.mailStore.getJob(queued.envelope.id)!;
      assert.equal(abandoned.result, "abandoned"); assert.equal(abandoned.generation, undefined); assert.equal(abandoned.reported, undefined);
      assert.equal(broker.mailStore.get(abandoned.id)?.cancellationReason, reason);
      const inspected = await tools.get("inspect_agent")!.execute("abandoned-inspect", { address }, undefined, undefined, ctx);
      assert.match(JSON.stringify(inspected.content), /abandoned by/);
      const dashboard = new DashboardComponent(() => broker!.getSnapshot(), () => [], () => {}, () => {}, ctx.ui.theme, address, undefined, 80, (selected) => broker!.inspectAgent(selected));
      try {
        dashboard.handleInput("\r"); const rendered = dashboard.render(200).join("\n");
        assert.match(rendered, /abandoned/); assert.equal(rendered.includes("\u001b]52"), false);
      } finally { dashboard.dispose(); }
      if (process.env.PI_MECHANISTIC_PROOF) writeFileSync(process.env.PI_MECHANISTIC_PROOF, JSON.stringify({ jobs, abandoned }));
      ctx.shutdown();
    },
  });
  pi.registerCommand("mechanistic-route", {
    description: "Exercise the production LLM send tool and Python result loop",
    handler: async (_args, ctx) => {
      assert.ok(broker);
      if (process.env.PI_MECHANISTIC_ROUTE_ALLOWED === "1") {
        await assert.rejects(broker.send(broker.mainAddress, { to: "monitor.route@mechanistic.com", subject: "Unauthorized main", message: "{}", priority: "low" }), /does not authorize main callers/);
        assert.equal(broker.mailStore.listJobs().length, 0);
      }
      const accepted = await broker.send(broker.mainAddress, { to: "scout.e2e@mock-e2e.com", subject: "MECHANISTIC_ROUTE", message: "MECHANISTIC_ROUTE", priority: "low", requires_response: false });
      const end = Date.now() + 15_000;
      while (true) {
        const worker = broker.getSnapshot().agents.find((agent) => agent.address === accepted.envelope.to);
        const finished = process.env.PI_MECHANISTIC_ROUTE_ALLOWED === "1"
          ? broker.mailStore.list().some((mail) => mail.subject === "MECHANISTIC_LOOP_COMPLETE")
          : worker?.state === "idle";
        if (finished && broker.getSnapshot().capacity.runSlotsUsed === 0) break;
        if (Date.now() >= end) throw new Error(`Routing did not settle: ${JSON.stringify(broker.getSnapshot())}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(broker.getSnapshot().agents.some((agent) => agent.address === "reviewer.e2e@mock-e2e.com"), false, "ordinary LLM nested delegation remains denied");
      const worker = broker.getSnapshot().agents.find((agent) => agent.address === accepted.envelope.to)!;
      assert.equal(worker.kind, "llm"); if (worker.kind !== "llm") throw new Error("missing LLM identity");
      await tools.get("inspect_agent")!.execute("inspect-worker", { address: worker.address }, undefined, undefined, ctx);
      const dashboard = new DashboardComponent(() => broker!.getSnapshot(), (address) => broker!.fetchUnanswered(address), () => {}, () => {}, ctx.ui.theme, worker.address, undefined, 80, (address) => broker!.inspectAgent(address));
      try {
        assert.match(dashboard.render(200).join("\n"), /mock-e2e/);
        dashboard.handleInput("\r");
        for (let tab = 0; tab < 4; tab++) {
          for (const width of [30, 80, 200]) assert.ok(dashboard.render(width).length > 0);
          dashboard.handleInput("\t");
        }
        for (const key of ["i", "i", "m", "\x0f", "d", "\x1b[A", "\x1b[B"]) dashboard.handleInput(key);
        dashboard.invalidate();
      } finally { dashboard.dispose(); }
      const source = new ConversationSource(worker.sessionFile!, 0, 100);
      await source.refresh(true); assert.ok(source.blocks.length > 0);
      assert.match(formatConversationTranscript(source.blocks), /MECHANISTIC_ROUTE/);
      assert.ok(formatConversationPreview(source.blocks).length > 0);
      assert.match(formatConversationTranscript([]), /no recorded/); assert.match(formatConversationPreview([]), /loading/);
      const conversation = new ConversationComponent(worker.address, source, () => {}, () => {}, ctx.ui.theme, 20, undefined, 0);
      try {
        assert.ok(conversation.render(100).length > 0); conversation.invalidate();
        for (const key of ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~", "\x1b[H", "\x1b[F", "\x1b"]) conversation.handleInput(key);
        assert.ok(conversation.render(40).length > 0);
      } finally { conversation.dispose(); }
      if (process.env.PI_MECHANISTIC_PROOF) writeFileSync(process.env.PI_MECHANISTIC_PROOF, JSON.stringify({ accepted, jobs: broker.mailStore.listJobs(), mail: broker.mailStore.list(), snapshot: broker.getSnapshot() }));
      ctx.shutdown();
    },
  });
  pi.registerCommand("mechanistic-inspect", {
    description: "Persist restored production job evidence without replaying an invocation",
    handler: async (_args, ctx) => {
      assert.ok(broker);
      const jobs = broker.mailStore.listJobs();
      const inspections = [];
      for (const address of new Set(jobs.map((job) => job.address))) {
        const inspected = await tools.get("inspect_agent")!.execute("inspect-restored", { address }, undefined, undefined, ctx);
        const text = JSON.stringify(inspected.content);
        for (const job of jobs.filter((candidate) => candidate.address === address)) {
          assert.ok(text.includes(job.id));
          if (job.cleanup?.detail) assert.match(text, /cleanup detail:/);
        }
        inspections.push(inspected.content);
      }
      if (process.env.PI_MECHANISTIC_PROOF) writeFileSync(process.env.PI_MECHANISTIC_PROOF, JSON.stringify({ jobs, mail: broker.mailStore.list(), snapshot: broker.getSnapshot(), inspections }));
      ctx.shutdown();
    },
  });
}
