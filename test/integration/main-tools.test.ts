import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { AgentBroker } from "../../src/broker.ts";
import { MAX_CONFIG_INSTRUCTIONS_BYTES, MAX_CONFIG_PROFILE_TOOLS } from "../../src/config.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import type { EmailEnvelope, WaitForRepliesResult } from "../../src/types.ts";

function waitRequest(id: string, subject = id): EmailEnvelope {
  return {
    id,
    from: "main@gpt-5.4.com",
    to: "worker.task@gpt-5.4.com",
    subject,
    message: "request",
    priority: "low",
    kind: "request",
    requiresResponse: true,
    createdAt: "2026-08-23T00:00:00.000Z",
    deliveryState: "delivered",
  };
}

async function renderWait(result: WaitForRepliesResult, toolResultByteLimit = 40_000) {
  const broker = {
    toolResultByteLimit,
    waitForReplies: async () => result,
  } as unknown as AgentBroker;
  const wait = createMainCoordinationTools(() => broker)[1];
  return wait.execute(
    "wait-guidance",
    { request_ids: result.items.map((item) => item.requestId), timeout_seconds: 0, collect: true },
    undefined,
    undefined,
    {} as never,
  );
}

it("exposes inspection, reply joining, audited cancellation, and lifecycle control without a spawn tool", async () => {
  const tools = createMainCoordinationTools(() => undefined);
  assert.deepEqual(tools.map((tool) => tool.name), ["inspect_agent", "wait_for_replies", "cancel_request", "manage_agent"]);
  assert.equal(tools.some((tool) => tool.name.includes("spawn")), false);
  const wait = tools[1];
  assert.equal(wait.executionMode, "sequential");
  assert.match(wait.description, /bounded (observation|collection) window/i);
  assert.match(wait.description, /late replies remain durable.*ordinary main presentation is attempted.*without a durable append receipt/i);
  assert.match(wait.description, /at-most-one live presentation.*not crash-proof exactly once.*no staged tool-result append receipt/i);
  const waitGuidelines = wait.promptGuidelines ?? [];
  assert.match(waitGuidelines.join("\n"), /do not.*rejoin.*keep.*alive/i);
  assert.match(waitGuidelines.join("\n"), /deliberate synchronous.*(collection|status).*window/i);
  const waitParameters = wait.parameters as {
    properties: {
      request_ids: { minItems?: number; maxItems?: number };
      timeout_seconds: { default?: number; minimum?: number; maximum?: number };
      collect: { default?: boolean };
    };
  };
  assert.equal(waitParameters.properties.request_ids.minItems, 1);
  assert.equal(waitParameters.properties.request_ids.maxItems, 32);
  assert.equal(waitParameters.properties.timeout_seconds.default, 120);
  assert.equal(waitParameters.properties.timeout_seconds.minimum, 0);
  assert.equal(waitParameters.properties.timeout_seconds.maximum, 300);
  assert.equal(waitParameters.properties.collect.default, true);

  await assert.rejects(
    tools[0].execute(
      "inspect-unready",
      { address: "worker.task@gpt-5.4.com" },
      undefined,
      undefined,
      {} as never,
    ),
    /Could not inspect agent: Email broker is not ready/,
  );
  await assert.rejects(
    tools[2].execute(
      "cancel-unready",
      { request_id: "mail_abandoned", reason: "Owner abandoned the request." },
      undefined,
      undefined,
      {} as never,
    ),
    /Could not cancel request: Email broker is not ready/,
  );
  const action = (tools[3].parameters as { properties: { action: unknown } }).properties.action;
  assert.deepEqual(action, { type: "string", enum: ["stop", "restart", "archive", "clear_failure", "recover_cleanup"] });
  assert.match(tools[0].description, /identity-lease.*run-slot.*archive blockers/i);
  const manageGuidance = (tools[3].promptGuidelines ?? []).join("\n");
  assert.match(manageGuidance, /stop.*does not free.*maxAgents/i);
  assert.match(manageGuidance, /cancel only.*explicitly abandoned.*exact requests/i);
  assert.match(manageGuidance, /restarting a failed agent.*inspect.*Work.*Conversation.*restart.*same identity/i);
  assert.match(manageGuidance, /recover_cleanup only after the human explicitly authorizes.*exact.*workerGeneration.*external quiescence/i);
  assert.match(manageGuidance, /capacity pressure alone is never authorization/i);
  const manageProperties = (tools[3].parameters as { properties: Record<string, any> }).properties;
  assert.equal(manageProperties.workerGeneration.minimum, 1);
  assert.equal(manageProperties.operatorEvidence.minLength, 8);
  assert.equal(manageProperties.operatorEvidence.maxLength, 1024);
});

it("returns exact bounded prospective capability details without truncating tool names", async () => {
  const tools = Array.from({ length: MAX_CONFIG_PROFILE_TOOLS }, (_, index) => {
    const prefix = `tool-${index}-`;
    return `${prefix}${"x".repeat(100 - prefix.length)}`;
  });
  const instructions = "i".repeat(MAX_CONFIG_INSTRUCTIONS_BYTES);
  const inspection = {
    address: "worker.bound@gpt-5.6-sol.com", exists: false, wouldSpawn: true, capacityAvailable: true,
    capacity: { identitiesUsed: 0, identitiesLimit: 8, runSlotsUsed: 0, runSlotsLimit: 4 }, holdsActivationLease: false,
    modelId: "gpt-5.6-sol", provider: "openai-codex", effort: "medium", role: "worker", tools, instructions,
    writable: true, canSpawn: false, state: "new", queued: 0, unanswered: 0, outgoingUnanswered: 0, pendingReplies: 0,
    archiveEligible: false,
    archiveBlockers: {
      active: false, cleanupQuarantine: false,
      queued: { count: 0, requestIds: [], omitted: 0 }, incomingUnanswered: { count: 0, requestIds: [], omitted: 0 },
      outgoingUnanswered: { count: 0, requestIds: [], omitted: 0 }, pendingReplies: { count: 0, requestIds: [], omitted: 0 },
    },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    providerReady: "unknown",
    lifecycle: {
      spawnTimeoutMs: 30_000, promptAcceptanceTimeoutMs: 30_000, runTimeoutMs: 14_400_000,
      idleTimeoutMs: 900_000, abortTimeoutMs: 10_000, disposeTimeoutMs: 10_000, brokerShutdownTimeoutMs: 60_000,
    },
  };
  const broker = { inspectAgent: () => inspection } as unknown as AgentBroker;
  const [inspect] = createMainCoordinationTools(() => broker);
  const result = await inspect.execute("inspect-bounded", { address: inspection.address }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.match(text, new RegExp(tools[0]!));
  assert.match(text, new RegExp(tools.at(-1)!));
  const details = result.details as { inspection: typeof inspection };
  assert.deepEqual(details.inspection.tools, tools);
  assert.equal(details.inspection.instructions, instructions);
});

it("previews an initial effort override without spawning", async () => {
  let call: { address?: string; effort?: string } = {};
  const broker = {
    inspectAgent(address: string, effort?: string) {
      call = { address, effort };
      return {
        address,
        exists: false,
        wouldSpawn: true,
        capacityAvailable: true,
        capacity: { identitiesUsed: 0, identitiesLimit: 8, runSlotsUsed: 0, runSlotsLimit: 4 },
        holdsActivationLease: false,
        modelId: "gpt-5.6-sol",
        provider: "openai-codex",
        effort: effort ?? "medium",
        role: "worker",
        tools: ["read", "bash", "edit", "write", "send_email", "fetch_emails"],
        writable: true,
        canSpawn: true,
        state: "new",
        queued: 0,
        unanswered: 0,
        outgoingUnanswered: 0,
        pendingReplies: 0,
        archiveEligible: false,
        archiveBlockers: {
          active: false,
          cleanupQuarantine: false,
          queued: { count: 0, requestIds: [], omitted: 0 },
          incomingUnanswered: { count: 0, requestIds: [], omitted: 0 },
          outgoingUnanswered: { count: 0, requestIds: [], omitted: 0 },
          pendingReplies: { count: 0, requestIds: [], omitted: 0 },
        },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        providerReady: "unknown",
        lifecycle: {
          spawnTimeoutMs: 30_000,
          promptAcceptanceTimeoutMs: 30_000,
          runTimeoutMs: 14_400_000,
          idleTimeoutMs: 900_000,
          abortTimeoutMs: 10_000,
          disposeTimeoutMs: 10_000,
          brokerShutdownTimeoutMs: 60_000,
        },
      };
    },
  } as unknown as AgentBroker;
  const [inspect] = createMainCoordinationTools(() => broker);
  const result = await inspect.execute(
    "inspect-effort",
    { address: "worker.deep@gpt-5.6-sol.com", effort: "xhigh" },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(call, { address: "worker.deep@gpt-5.6-sol.com", effort: "xhigh" });
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /effort xhigh/);
  assert.match(text, /Selection: prospective provider\/model under the current main-provider preference.*first accepted mail persists it/i);
  const effort = (inspect.parameters as {
    properties: { effort: { anyOf?: unknown[]; enum?: string[] } };
  }).properties.effort;
  const effortSchema = (effort.anyOf?.find((item) => (item as { enum?: string[] }).enum) ?? effort) as { enum?: string[] };
  assert.deepEqual(effortSchema.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

it("renders derived capacity, lease, obligations, archive eligibility, and safe recovery", async () => {
  const requestIds = ["mail_incoming", "mail_outgoing"];
  const inspection = {
    address: "worker.capacity@gpt-5.4.com",
    exists: true,
    wouldSpawn: false,
    capacityAvailable: true,
    capacity: { identitiesUsed: 2, identitiesLimit: 2, runSlotsUsed: 1, runSlotsLimit: 1 },
    holdsActivationLease: true,
    modelId: "gpt-5.4",
    provider: "openai-codex",
    effort: "medium",
    role: "worker",
    tools: ["read", "send_email", "fetch_emails"],
    writable: false,
    canSpawn: true,
    state: "stopped",
    queued: 0,
    unanswered: 1,
    outgoingUnanswered: 1,
    pendingReplies: 0,
    archiveEligible: false,
    archiveBlockers: {
      active: false,
      cleanupQuarantine: false,
      queued: { count: 0, requestIds: [], omitted: 0 },
      incomingUnanswered: { count: 1, requestIds: [requestIds[0]], omitted: 0 },
      outgoingUnanswered: { count: 1, requestIds: [requestIds[1]], omitted: 0 },
      pendingReplies: { count: 0, requestIds: [], omitted: 0 },
    },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    providerReady: "unknown",
    lifecycle: {
      spawnTimeoutMs: 30_000, promptAcceptanceTimeoutMs: 30_000, runTimeoutMs: 10_000,
      idleTimeoutMs: 5_000, abortTimeoutMs: 1_000, disposeTimeoutMs: 1_000, brokerShutdownTimeoutMs: 5_000,
    },
  };
  const broker = { inspectAgent: () => inspection } as unknown as AgentBroker;
  const rendered = await createMainCoordinationTools(() => broker)[0].execute(
    "inspect-capacity", { address: inspection.address }, undefined, undefined, {} as never,
  );
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /Binding: persisted exact provider\/model.*ignores current main-provider preference/i);
  assert.match(text, /Identity capacity: 2\/2 used.*holds a lease: yes.*available for this address: yes/i);
  assert.match(text, /Run concurrency: 1\/1 slots used/i);
  assert.match(text, /1 incoming unanswered.*1 outgoing unanswered/i);
  assert.match(text, /Archive eligible: no/i);
  assert.match(text, /restart.*real obligations/i);
  assert.match(text, /cancel only.*explicitly abandoned.*exact request/i);
  for (const id of requestIds) assert.match(text, new RegExp(id));
  assert.doesNotMatch(text, /subject|body/i);
  const details = rendered.details as { inspection: any };
  assert.deepEqual(details.inspection.capacity, inspection.capacity);
  assert.equal(details.inspection.holdsActivationLease, true);
  assert.equal(details.inspection.archiveEligible, false);

  inspection.providerReady = "unavailable";
  const unavailable = await createMainCoordinationTools(() => broker)[0].execute(
    "inspect-unavailable", { address: inspection.address }, undefined, undefined, {} as never,
  );
  assert.match(
    (unavailable.content[0] as { text: string }).text,
    /Binding: persisted exact provider\/model.*unavailable in current catalog.*no provider substitution/i,
  );

  (inspection as any).cleanup = {
    state: "unknown", reasonCode: "ABANDONED_OWNER_RECOVERY", workerGeneration: 1,
    startedAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:01.000Z",
    abort: "timed-out", dispose: "timed-out", quiescence: "unknown",
    mutationCapableAtStart: true, heldRunSlot: false, activeTools: [],
  };
  const quarantined = await createMainCoordinationTools(() => broker)[0].execute(
    "inspect-cleanup", { address: inspection.address }, undefined, undefined, {} as never,
  );
  const quarantineText = (quarantined.content[0] as { text: string }).text;
  assert.match(quarantineText, /human-authorized exact-generation recover_cleanup.*external quiescence verification/is);
  assert.match(quarantineText, /capacity pressure alone is never authorization/i);
  assert.doesNotMatch(quarantineText, /wait for.*cleanup/i);
});

it("renders terminal recovery from existing failure, mailbox, and current-batch work without private payloads", async () => {
  const work = {
    nextBatchId: 2,
    currentBatchId: 1,
    active: [],
    recent: [{
      toolCallId: "effect", batchId: 1, toolName: "bash", kind: "shell", attribution: "unverified", status: "succeeded",
      startedAt: "2026-08-23T00:00:00.000Z", endedAt: "2026-08-23T00:00:01.000Z", commandPreview: "PRIVATE COMMAND",
    }],
    inspection: { reads: 0, searches: 0, listings: 0 },
  };
  const inspection = {
    address: "worker.failed@gpt-5.4.com", exists: true, wouldSpawn: false, capacityAvailable: true,
    capacity: { identitiesUsed: 1, identitiesLimit: 8, runSlotsUsed: 0, runSlotsLimit: 4 }, holdsActivationLease: true,
    modelId: "gpt-5.4", provider: "openai-codex", effort: "medium", role: "worker",
    tools: ["bash", "send_email", "fetch_emails"], writable: true, canSpawn: true, state: "failed",
    queued: 0, unanswered: 1, outgoingUnanswered: 0, pendingReplies: 0, archiveEligible: false,
    archiveBlockers: {
      active: false, cleanupQuarantine: false,
      queued: { count: 0, requestIds: [], omitted: 0 },
      incomingUnanswered: { count: 1, requestIds: ["mail_open"], omitted: 0 },
      outgoingUnanswered: { count: 0, requestIds: [], omitted: 0 },
      pendingReplies: { count: 0, requestIds: [], omitted: 0 },
    },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    failure: "WebSocket error terminally",
    providerReady: "unknown",
    lifecycle: {
      spawnTimeoutMs: 30_000, promptAcceptanceTimeoutMs: 30_000, runTimeoutMs: 10_000,
      idleTimeoutMs: 5_000, abortTimeoutMs: 1_000, disposeTimeoutMs: 1_000, brokerShutdownTimeoutMs: 5_000,
    },
  };
  const broker = {
    inspectAgent: () => inspection,
    mailStore: { list: () => [{
      to: inspection.address, kind: "request", requiresResponse: true, deliveryState: "delivered", answeredAt: undefined,
      subject: "PRIVATE MAIL SUBJECT", message: "PRIVATE MAIL BODY",
    }] },
    getSnapshot: () => ({ agents: [{
      address: inspection.address,
      provider: inspection.provider,
      modelId: inspection.modelId,
      work,
      activity: [{ at: "2026-08-23T00:00:02.000Z", kind: "status", summary: "Agent run failed" }],
    }] }),
  } as unknown as AgentBroker;
  const [inspect] = createMainCoordinationTools(() => broker);
  const rendered = await inspect.execute("inspect-failure", { address: inspection.address }, undefined, undefined, {} as never);
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /Terminal worker run failure.*openai-codex\/gpt-5\.4.*external or unclear/is);
  assert.match(text, /1 delivered request remains unanswered/i);
  assert.match(text, /current batch includes mutation\/shell\/custom work.*effects may exist/is);
  assert.match(text, /inspect Work and Conversation.*explicit same-identity restart/is);
  assert.match(text, /do not redelegate.*possible-effect scope.*original obligation remains open/is);
  assert.doesNotMatch(text, /PRIVATE COMMAND|PRIVATE MAIL SUBJECT|PRIVATE MAIL BODY/);

  work.recent = [];
  const cautious = await inspect.execute("inspect-empty-failure", { address: inspection.address }, undefined, undefined, {} as never);
  const cautiousText = (cautious.content[0] as { text: string }).text;
  assert.match(cautiousText, /No mutation\/shell\/custom effect is recorded.*not proof of pre-tool failure/is);
  assert.match(cautiousText, /inspect Conversation.*same-identity restart/is);
});

it("reports actual post-action identity capacity in manage_agent results", async () => {
  let state: "stopped" | "archived" = "stopped";
  let holdsActivationLease = true;
  let identitiesUsed = 1;
  const inspection = () => ({
    address: "worker.capacity@gpt-5.4.com", state, holdsActivationLease,
    capacity: { identitiesUsed, identitiesLimit: 1, runSlotsUsed: 0, runSlotsLimit: 1 },
    archiveEligible: state === "stopped",
  });
  const broker = {
    stop: async () => { state = "stopped"; },
    restart: async () => undefined,
    archive: async () => { state = "archived"; holdsActivationLease = false; identitiesUsed = 0; },
    clearFailure: async () => undefined,
    inspectAgent: inspection,
  } as unknown as AgentBroker;
  const manage = createMainCoordinationTools(() => broker)[3];
  const stopped = await manage.execute(
    "manage-stop", { address: inspection().address, action: "stop" }, undefined, undefined, {} as never,
  );
  assert.match((stopped.content[0] as { text: string }).text, /lease remains held.*stop alone does not free.*maxAgents/i);
  assert.deepEqual((stopped.details as any).capacity, inspection().capacity);
  assert.equal((stopped.details as any).holdsActivationLease, true);

  const archived = await manage.execute(
    "manage-archive", { address: inspection().address, action: "archive" }, undefined, undefined, {} as never,
  );
  assert.match((archived.content[0] as { text: string }).text, /lease released.*Identity capacity: 0\/1/i);
  assert.equal((archived.details as any).holdsActivationLease, false);
  assert.equal((archived.details as any).capacity.identitiesUsed, 0);
});

it("renders recover_cleanup as operator-attested without exposing the evidence or performing another action", async () => {
  const calls: string[] = [];
  const inspection = {
    address: "worker.recovery@gpt-5.4.com",
    state: "failed",
    holdsActivationLease: true,
    capacity: { identitiesUsed: 1, identitiesLimit: 1, runSlotsUsed: 0, runSlotsLimit: 1 },
    archiveEligible: false,
  };
  const broker = {
    recoverCleanup: async (_address: string, generation: number, _evidence: string) => {
      calls.push(`recover:${generation}`);
      return {
        workerGeneration: generation,
        releasedAt: "2026-08-23T00:00:00.000Z",
        evidence: "PRIVATE OPERATOR EVIDENCE",
        source: "operator-attested" as const,
      };
    },
    stop: async () => { calls.push("stop"); },
    restart: async () => { calls.push("restart"); },
    archive: async () => { calls.push("archive"); },
    clearFailure: async () => { calls.push("clear"); },
    inspectAgent: () => inspection,
  } as unknown as AgentBroker;
  const manage = createMainCoordinationTools(() => broker)[3];
  const result = await manage.execute("manage-recovery", {
    address: inspection.address,
    action: "recover_cleanup",
    workerGeneration: 9,
    operatorEvidence: "Operator verified external quiescence.",
  }, undefined, undefined, {} as never);
  assert.deepEqual(calls, ["recover:9"]);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /generation 9.*operator-released.*not Pi-verified.*no restart, archive, or mail delivery/is);
  assert.doesNotMatch(text, /PRIVATE OPERATOR EVIDENCE/);
  assert.deepEqual((result.details as any).cleanupRecovery, {
    workerGeneration: 9,
    releasedAt: "2026-08-23T00:00:00.000Z",
    source: "operator-attested",
  });
  assert.equal((result.details as any).cleanupRecovery.evidence, undefined);
});

it("guides timed-out pending waits without changing exact structured results", async () => {
  const request = waitRequest("mail_pending", "Long-running delegated task");
  const pending: WaitForRepliesResult = {
    complete: false,
    timedOut: true,
    items: [{ requestId: request.id, state: "pending", request }],
  };
  const rendered = await renderWait(pending);
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /Replies: timed out with pending work/);
  assert.match(text, /at most one live presentation.*Pi 0\.81\.1.*no staged tool-result append receipt/is);
  assert.match(text, /mail journal answered.*before.*tool result.*durably present/is);
  assert.match(text, /pending requests remain correlated/i);
  assert.match(text, /ordinary main presentation is attempted.*no durable sendMessage append acknowledgement/i);
  assert.match(text, /no immediate keepalive rejoin/i);
  assert.match(text, /rejoin.*stable request ID.*deliberate (collection|status).*after restart/is);
  assert.match(text, /after restart.*presentation uncertainty/i, "the same structured branch remains accurate during pending shutdown");
  assert.doesNotMatch(text, /request (expired|was lost)|reply already exists/i);

  const details = rendered.details as { result: WaitForRepliesResult };
  assert.equal(details.result.complete, false);
  assert.equal(details.result.timedOut, true);
  assert.deepEqual(details.result.items.map((item) => [item.requestId, item.state]), [[request.id, "pending"]]);
  assert.equal(details.result.items[0]?.request?.message, "[body omitted from structured tool details; see tool text]");
});

it("omits timeout guidance for complete, terminal, and abort-partial results", async () => {
  const answeredRequest = waitRequest("mail_answered", "Answered task");
  const answeredReply = {
    ...waitRequest("reply_answered", `Re: [${answeredRequest.id}] ${answeredRequest.subject}`),
    from: answeredRequest.to,
    to: answeredRequest.from,
    message: "Done.",
    kind: "reply" as const,
    inReplyTo: answeredRequest.id,
    requiresResponse: false,
  };
  const cases: WaitForRepliesResult[] = [
    {
      complete: true,
      timedOut: false,
      items: [{ requestId: answeredRequest.id, state: "answered", request: answeredRequest, reply: answeredReply }],
    },
    {
      complete: true,
      timedOut: false,
      items: [{ requestId: "mail_failed", state: "failed", request: waitRequest("mail_failed"), error: "Agent failed." }],
    },
    {
      complete: false,
      timedOut: false,
      items: [{ requestId: "mail_aborted", state: "pending", request: waitRequest("mail_aborted") }],
    },
  ];
  for (const result of cases) {
    const rendered = await renderWait(result);
    const text = (rendered.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /pending requests remain correlated/i);
    assert.doesNotMatch(text, /keep.*alive/i);
    if (!result.complete) assert.match(text, /Replies: partial/);
  }
});

it("keeps timeout guidance and exact IDs within output bounds for the largest normal join", async () => {
  const items = Array.from({ length: 32 }, (_, index) => {
    const id = `mail_pending_${String(index).padStart(2, "0")}`;
    const request = waitRequest(id, `Task ${index} ${"界".repeat(160)}`);
    return { requestId: id, state: "pending" as const, request };
  });
  const rendered = await renderWait({ complete: false, timedOut: true, items });
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /pending requests remain correlated/i);
  assert.match(text, /no immediate keepalive rejoin/i);
  for (const item of items) assert.match(text, new RegExp(item.requestId));
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  const details = rendered.details as { result: WaitForRepliesResult };
  assert.deepEqual(details.result.items.map((item) => item.requestId), items.map((item) => item.requestId));
});

it("bounds joined reply bodies and directs callers to re-fetch omitted IDs", async () => {
  const request = (id: string): EmailEnvelope => ({
    id,
    from: "main@gpt-5.4.com",
    to: "worker.task@gpt-5.4.com",
    subject: id,
    message: "request",
    priority: "low",
    kind: "request",
    requiresResponse: true,
    createdAt: new Date().toISOString(),
    deliveryState: "delivered",
  });
  const items = ["mail_one", "mail_two"].map((id) => {
    const original = request(id);
    return {
      requestId: id,
      state: "answered" as const,
      request: original,
      reply: {
        ...request(`reply_${id}`),
        from: original.to,
        to: original.from,
        subject: `Re: [${id}] ${id}`,
        message: "x".repeat(180),
        kind: "reply" as const,
        inReplyTo: id,
        requiresResponse: false,
      },
    };
  });
  const result: WaitForRepliesResult = { complete: true, timedOut: false, items };
  const broker = {
    toolResultByteLimit: 300,
    waitForReplies: async () => result,
  } as unknown as AgentBroker;
  const tools = createMainCoordinationTools(() => broker);
  const rendered = await tools[1].execute(
    "wait-bounded",
    { request_ids: ["mail_one", "mail_two"], timeout_seconds: 0, collect: true },
    undefined,
    undefined,
    {} as never,
  );
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /reply body omitted/);
  assert.match(text, /call wait_for_replies again with only mail_/);
  assert.ok(Buffer.byteLength(text) < 1_000, "summary remains bounded even when reply bodies are omitted");
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  const details = rendered.details as { result: WaitForRepliesResult };
  assert.equal(details.result.items[0]?.request?.message, "[body omitted from structured tool details; see tool text]");
  assert.equal(details.result.items[0]?.reply?.message, "[body omitted from structured tool details; see tool text]");
});
