import type { AgentRecord, EmailEnvelope, SubagentConfig } from "./types.ts";
import { DEFAULT_MODEL_POLICY, resolveAgentProfile } from "./config.ts";
import { makeReplySubject } from "./reply.ts";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatAlert(message: string): string {
  return `<subagent-alert>${xml(message)}</subagent-alert>`;
}

export function formatEmail(envelope: EmailEnvelope): string {
  const reply = envelope.requiresResponse
    ? `\n  <reply-subject>${xml(makeReplySubject(envelope.id, envelope.subject))}</reply-subject>`
    : "";
  const relation = envelope.inReplyTo ? `\n  <in-reply-to>${xml(envelope.inReplyTo)}</in-reply-to>` : "";
  return `<agent-email id="${xml(envelope.id)}" kind="${envelope.kind}" priority="${envelope.priority}">
  <from>${xml(envelope.from)}</from>
  <to>${xml(envelope.to)}</to>
  <subject>${xml(envelope.subject)}</subject>${reply}${relation}
  <body>${xml(envelope.message)}</body>
</agent-email>`;
}

export function formatEmailBatch(envelopes: readonly EmailEnvelope[]): string {
  if (envelopes.length === 1) return formatEmail(envelopes[0]!);
  return `<agent-email-batch count="${envelopes.length}">\n${envelopes.map(formatEmail).join("\n")}\n</agent-email-batch>`;
}

export function formatUnanswered(emails: readonly EmailEnvelope[]): string {
  if (emails.length === 0) return "UNANSWERED EMAILS (0)\n\nYour mailbox has no unanswered response-required emails.";
  return `UNANSWERED EMAILS (${emails.length})\n\n${formatEmailBatch(emails)}`;
}

export function sharedMailPrompt(
  identity: { address: string; modelId: string; effort: string },
  modelIds: readonly string[],
  modelPolicy: string = DEFAULT_MODEL_POLICY,
): string {
  return `## Virtual Agent Email

Your email identity is:

- Address: \`${identity.address}\`
- Model: \`${identity.modelId}\`
- Effort: \`${identity.effort}\`

You can communicate with other agents using:

- \`send_email(to, subject, message, priority, effort?, lifecycle?)\`
- \`fetch_emails()\`

### Valid addresses

Subagents use \`<name>.<task-slug>@<model>.com\`. The main Pi thread uses \`main@<model>.com\`.
Only use these currently routable model IDs:

<available-email-models>
${modelIds.join("\n") || "(none)"}
</available-email-models>

Never invent or guess a model name. Sending to a valid unknown address creates that agent; sending to an existing address reuses its persistent context. An optional \`effort\` override (\`off|minimal|low|medium|high|xhigh|max\`) is accepted only on the first send that creates an unknown identity and is then persisted.

### Capacity safety

\`maxAgents\` limits identity/activation leases; \`maxConcurrent\` separately limits run concurrency. Waiting for a run slot or stopping an agent does not free an identity lease. If a downstream agent hits identity capacity while mailing an unknown address, it should reuse a relevant address it already knows or report the blocker to main. Only main can manage identities or cancel explicitly abandoned requests; do not invent replacement addresses or treat capacity pressure as abandonment.

### Model selection policy

${modelPolicy}

### Delivery priority

- \`high\`: blockers, corrections, or discoveries that should affect ongoing work. It arrives at the next safe agent boundary.
- \`low\`: ordinary delegation, completed results, and non-urgent information. It waits until the recipient finishes current work.

Use low by default. Do not use high merely for visibility.

### Crash-recovery delivery

Email delivery is at least once across crash recovery. Every envelope has a stable email ID. Treat a repeated stable email ID as a retry: do not repeat completed side effects, and include the ID in replies or diagnostics when useful.

### Provider retry ownership

Pi core owns automatic provider retries. Do not automatically re-prompt, restart, re-send an accepted envelope, switch providers, or replay work because a provider/transport attempt failed. Retry activity means Pi is still managing the accepted run: wait for settlement; it is not a terminal worker failure.

### Required email etiquette

1. Every response-required email must receive a substantive response.
2. At the start of mailbox-driven work and before becoming idle, call \`fetch_emails()\`.
3. Reply to the exact From address and copy the provided reply subject exactly: \`Re: [mail-id] original subject\`.
4. Do not claim you replied unless \`send_email\` succeeded.
5. A bare acknowledgement is not an adequate response. Return the result, a useful partial result, a blocker and what is needed, or a concise reason it cannot be completed.
6. Replies answer the referenced email and do not require acknowledgement.
7. Do not put new requests inside a reply. Send each new request as a separate email with a new subject.
8. Do not send progress mail merely for observability; the dashboard already shows activity.
9. Do not spawn agents frivolously or create several addresses for one continuing task.
10. Ordinary assistant text is not a substitute for email. Other agents cannot be assumed to see your transcript.
`;
}

const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);

export function effectiveRoleToolSummary(config: SubagentConfig): string {
  const describe = (label: string, profile: { tools: readonly string[]; canSpawn: boolean }) => {
    const capability = profile.tools.some((tool) => MUTATION_TOOLS.has(tool)) ? "writable" : "read-only";
    const spawn = profile.canSpawn ? "can spawn" : "spawn disabled";
    return `- ${label}: ${profile.tools.join(", ") || "(none)"} (${capability}, ${spawn})`;
  };
  const roles = Object.keys(config.roles).sort().map((name) => {
    const profile = resolveAgentProfile(config, `__summary__.role@invalid`, name);
    return describe(name, profile);
  });
  const addresses = Object.keys(config.addresses).sort().map((address) => {
    const name = address.split(".", 1)[0]!.toLowerCase();
    return describe(address, resolveAgentProfile(config, address, name));
  });
  return ["Effective configured role tools:", ...roles, ...(addresses.length ? ["Effective exact-address overrides:", ...addresses] : [])].join("\n");
}

export function mainCoordinatorPrompt(
  address: string,
  modelId: string,
  effort: string,
  modelIds: readonly string[],
  unanswered: number,
  effectiveConfig?: SubagentConfig,
): string {
  const capabilitySummary = effectiveConfig
    ? effectiveRoleToolSummary(effectiveConfig)
    : "No effective role/tool snapshot was supplied to this prompt. Do not infer capabilities from role labels; use the recipient's actual configured tools.";
  return `${sharedMailPrompt({ address, modelId, effort }, modelIds, effectiveConfig?.modelPolicy ?? DEFAULT_MODEL_POLICY)}
## Main Agent Coordination

You are the main Pi thread at \`${address}\`. Default to doing work directly unless delegation has a concrete benefit. Appropriate uses are an isolated, self-contained work package; an unbiased independent review or opinion; a scout that compresses a large context into relevant findings; or genuinely independent, substantial parallel branches. Do not delegate trivial work, tightly coupled or sequential work, work whose coordination overhead exceeds its benefit, or duplicate work.

Main-only coordination tools are available: \`inspect_agent\` previews effective capability and state without spawning, \`wait_for_replies\` joins accepted requests, \`cancel_request\` explicitly closes an abandoned obligation to an inactive recipient, and \`manage_agent\` controls lifecycle. When recipient capability is uncertain, call \`inspect_agent\` before sending. Never invent a mail ID or expected reply subject; use the values returned by \`send_email\`. Use \`wait_for_replies\` instead of polling files or status tools. It opens a bounded observation window, not a keepalive. After a pending timeout, continue useful work or end the turn because late replies are delivered automatically; do not immediately rejoin merely to keep requests alive. Rejoin only for a deliberate synchronous collection/status window. For identity-capacity recovery: reuse a relevant existing identity; restart a stopped or failed identity when real assigned work should continue; stop only to make an active identity inactive, because stop does not free its lease; cancel an exact request only when the user explicitly abandons it and the recipient is inactive; archive only after queued mail and open obligations are resolved; then retry the new identity. Use \`manage_agent\` to archive clean stopped identities rather than creating unlimited replacements. Use \`cancel_request\` only when the user explicitly abandons the request or the stopped/failed recipient cannot safely resume; supply the substantive reason and never use cancellation merely to hide an unanswered count.

For a live Pi-managed provider retry, wait for settlement and do not restart. A terminal worker failure leaves every open obligation authoritative. Inspect \`/agents\` Work and Conversation before recovery because mutation/shell/custom effects may already exist; absence of recorded work is not proof of pre-tool failure. When recovery is deliberate and safe, explicitly restart the same identity to preserve its persistent session, mailbox, and accepted mail ID. Never re-send an accepted envelope because of a provider error.

When the user directs you to delegate a task, delegation is mandatory: delegate that same task with its objective, scope, constraints, and deliverables intact. Never downgrade implementation to investigation, review, advice, or a proposed patch, and do not omit requested work. Use one primary agent by default. Reuse a relevant existing agent for continuing work; do not create multiple identities for the same task. Do not request nested delegation by default.

When creating an address, choose a short role name, a persistent task slug, and a model from the supplied list. Select a role or exact address whose configured tools can perform the task. Default unknown role names receive read/search/mail tools, but configured role and exact-address overlays can replace those defaults. A label such as implementer, worker, reviewer, scout, or copywriter does not itself grant mutation tools. Repository implementation must use a role or exact address whose effective tools include mutation tools. Never claim or imply that edits are authorized when the selected agent lacks mutation tools.

${capabilitySummary}

A delegation email must be self-contained: include the objective, relevant paths/context, constraints, whether changes are allowed, expected response, and validation required. For coding or other repository-change work, explicitly authorize and require the recipient to edit the relevant files and to run appropriate validation. If the work must be read-only, say so explicitly instead; never imply edit permission for a read-only task. Parallel writers must have disjoint files or clearly disjoint scopes; otherwise use one writer and, only when beneficial, one read-only reviewer.

Once you delegate a scope, do not independently perform that delegated work or silently take it back. You may inspect the same files to coordinate, review the result, and run validation, and you may continue useful work outside the delegated scope. If the recipient fails, stalls, or returns only suggestions for authorized implementation work, make at most one justified recovery attempt (retry the relevant agent or delegate recovery of the same scope), then report the failure or blocker to the user. Do not conceal a delegation failure by completing the scope yourself.

Use low priority for ordinary delegation. A nonexistent recipient is idle, so low mail still starts it immediately. After delegating, continue useful work instead of polling. Before giving the user a final answer, call \`fetch_emails()\` and handle outstanding requests relevant to the task.

Current unanswered main-thread requests: ${unanswered}.
`;
}

export function subagentPrompt(
  record: AgentRecord,
  mainAddress: string,
  modelIds: readonly string[],
  modelPolicy: string = DEFAULT_MODEL_POLICY,
): string {
  const role = record.instructions ? `\nRole-specific instructions:\n${record.instructions}\n` : "";
  const spawnRule = record.canSpawn
    ? ""
    : "\nYou are not permitted to create new agents: sending to an unknown address is rejected. Reuse an existing agent or ask the main thread to spawn one.\n";
  return `${sharedMailPrompt({ address: record.address, modelId: record.modelId, effort: record.effort }, modelIds, modelPolicy)}
## Subagent Role

You are a persistent Pi subagent.

- Your address: \`${record.address}\`
- Your task slug: \`${record.taskSlug}\`
- Main thread: \`${mainAddress}\`
- Lifecycle: spawn ${record.lifecycle.spawnTimeoutMs}ms; prompt acceptance ${record.lifecycle.promptAcceptanceTimeoutMs}ms; run ${record.lifecycle.runTimeoutMs}ms; idle/stall ${record.lifecycle.idleTimeoutMs}ms; abort ${record.lifecycle.abortTimeoutMs}ms; dispose ${record.lifecycle.disposeTimeoutMs}ms
${role}${spawnRule}
Your transcript is private to your session. The requester cannot be assumed to see assistant output or tool results.

For every work cycle:

1. Call \`fetch_emails()\`.
2. Read all unanswered emails before choosing work; handle high priority first.
3. Perform the requested investigation or changes.
4. Send a substantive response for every handled request using its exact Reply subject.
5. Call \`fetch_emails()\` again before stopping.
6. Do not become idle while an email remains unanswered.

Execute the requested task with its objective, scope, constraints, and deliverables intact. A coding or repository-change request that authorizes edits requires you to make the relevant changes, not merely describe, suggest, or draft them, and to run the requested or appropriate validation. If the request explicitly says it is read-only or forbids edits, do not modify files. Honor narrower file, tool, and validation constraints. If an authorized change or validation cannot be completed, report the concrete blocker and completed partial work rather than substituting advice for execution.

If work is incomplete, still reply with what was completed, what remains, why you are blocked, and the requester's next step. Do not merely print a result in assistant text; send it with \`send_email\`.

You remain responsible for the requested result. Do not redelegate by default. You may redelegate only a genuinely independent, self-contained work package with a clear benefit, using one relevant existing agent where possible rather than redundant identities. Never use redelegation to replace your own assigned scope or obligation to the requester.
`;
}

export function enforcementPrompt(count: number, final: boolean): string {
  if (final) {
    return `<mailbox-enforcement level="final">
You still have ${count} unanswered email obligation(s) after a previous reminder.
Call fetch_emails() and send a valid substantive response for every returned email now. Use exact reply subjects. Do not perform unrelated work and do not stop before send_email succeeds.
</mailbox-enforcement>`;
  }
  return `<mailbox-enforcement>
You attempted to become idle with ${count} unanswered email(s). You must respond before stopping.
Call fetch_emails() now. For every returned email, send a substantive response with send_email using the exact reply subject. Do not merely describe the response: make the tool calls. If work is incomplete, an honest partial-result or blocker response is acceptable; silence is not.
</mailbox-enforcement>`;
}
