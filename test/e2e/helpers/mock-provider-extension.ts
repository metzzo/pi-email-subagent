/**
 * Deterministic scripted provider for real end-to-end tests.
 *
 * Loaded into a real Pi process alongside the extension under test:
 *
 *   pi -ne -e test/e2e/helpers/mock-provider-extension.ts -e ./src/index.ts \
 *      --mode rpc --no-session --model mock-e2e/mock-e2e
 *
 * The provider never performs network I/O. Its stream function inspects the
 * conversation context and emits scripted tool calls (or text) so the whole
 * email pipeline — broker, journaling, real SDK worker sessions, steering,
 * collection — runs for real. Only the LLM is scripted.
 *
 * Main-thread script (system prompt contains "Main Agent Coordination"):
 *   user "E2E DELEGATE [SLOW <ms>] [HIGH] [NOWAIT]" → send_email to the scout
 *   user "E2E DELEGATE REVIEWER ..."                → send_email to the reviewer
 *   user "E2E DELEGATE BOTH ..."                    → two parallel send_email calls
 *   user "E2E SEND INVALID NOWAIT"                  → three invalid send_email calls
 *   user "E2E RATE NOWAIT"                          → four parallel send_email calls
 *   user "E2E INSPECT"                              → inspect_agent on the scout
 *   user "E2E STOP" / "E2E ARCHIVE"                 → manage_agent
 *   send_email result                                → wait_for_replies for all
 *                                                      correlation IDs seen so
 *                                                      far (or finish on NOWAIT)
 *   wait_for_replies / manage_agent / inspect result → final text
 *
 * Worker script (system prompt contains "Subagent Role"):
 *   email batch / steer / enforcement prompt → fetch_emails (after optional
 *                                              SLOW delay to simulate work)
 *   fetch_emails result                      → one send_email reply per
 *                                              unanswered email, exact subjects
 *   send_email result                        → "WORKER DONE"
 *   email body containing "CRASH"            → the stream throws (terminal error)
 *   email body containing "IGNORE"           → first fetch result is met with
 *                                              silence until a mailbox-
 *                                              enforcement prompt arrives
 */
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MOCK_PROVIDER_ID = "mock-e2e";
export const MOCK_MODEL_ID = "mock-e2e";
export const MOCK_WORKER_ADDRESS = "scout.e2e@mock-e2e.com";
export const MOCK_REVIEWER_ADDRESS = "reviewer.e2e@mock-e2e.com";
export const MOCK_MAIN_ADDRESS = "main@mock-e2e.com";
const RATE_ADDRESSES = ["scout.e2e", "scout.two", "scout.three", "scout.four"].map((name) => `${name}@mock-e2e.com`);

type ToolCallPlan = { name: string; arguments: Record<string, unknown> };
type Plan = { toolCalls: ToolCallPlan[] } | { text: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(message: Message | undefined): string {
  const content = message?.content as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("\n");
  }
  return "";
}

function lastUserInstruction(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = messageText(message);
      if (text.includes("E2E")) return text;
    }
  }
  return "";
}

function allText(messages: readonly Message[]): string {
  return messages.map((message) => messageText(message)).join("\n");
}

function correlationIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message?.role !== "toolResult" || message.toolName !== "send_email") continue;
    for (const match of messageText(message).matchAll(/Correlation ID: (mail_\S+)/g)) {
      if (!ids.includes(match[1]!)) ids.push(match[1]!);
    }
  }
  return ids;
}

interface MailPair {
  from: string;
  replySubject: string;
}

function unansweredPairs(text: string): MailPair[] {
  const pairs: MailPair[] = [];
  for (const match of text.matchAll(/<agent-email[^>]*>([\s\S]*?)<\/agent-email>/g)) {
    const body = match[1]!;
    const from = /<from>([^<]+)<\/from>/.exec(body)?.[1];
    const replySubject = /<reply-subject>([^<]+)<\/reply-subject>/.exec(body)?.[1];
    if (from && replySubject) pairs.push({ from, replySubject });
  }
  return pairs;
}

function lastToolResultIndex(messages: readonly Message[], toolName: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolName === toolName) return index;
  }
  return -1;
}

function planMain(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const lastText = messageText(last);

  // If requests were sent but never joined (e.g. a steered alert preempted the
  // normal post-send turn), join them now — unless the instruction was NOWAIT
  // or the current message is a fresh instruction to execute first.
  const ids = correlationIds(messages);
  const lastIsInstruction = last?.role === "user" && lastText.includes("E2E");
  if (!lastIsInstruction
    && ids.length > 0
    && !lastUserInstruction(messages).includes("NOWAIT")
    && lastToolResultIndex(messages, "send_email") > lastToolResultIndex(messages, "wait_for_replies")) {
    return { toolCalls: [{ name: "wait_for_replies", arguments: { request_ids: ids, timeout_seconds: 90, collect: true } }] };
  }

  if (last?.role === "toolResult") {
    if (last.toolName === "send_email") {
      if (lastUserInstruction(messages).includes("NOWAIT")) return { text: "E2E SENT" };
      const ids = correlationIds(messages);
      if (ids.length === 0) return { text: "E2E NO REQUEST IDS" };
      return { toolCalls: [{ name: "wait_for_replies", arguments: { request_ids: ids, timeout_seconds: 90, collect: true } }] };
    }
    if (last.toolName === "wait_for_replies") return { text: "E2E COMPLETE" };
    if (last.toolName === "manage_agent") return { text: "E2E MANAGED" };
    if (last.toolName === "inspect_agent") return { text: "E2E INSPECTED" };
    return { text: "E2E PONG" };
  }

  if (lastText.includes('<agent-email') && lastText.includes('kind="reply"')) return { text: "E2E REPLY SEEN" };
  if (lastText.includes("E2E STOP")) {
    return { toolCalls: [{ name: "manage_agent", arguments: { address: MOCK_WORKER_ADDRESS, action: "stop" } }] };
  }
  if (lastText.includes("E2E ARCHIVE")) {
    return { toolCalls: [{ name: "manage_agent", arguments: { address: MOCK_WORKER_ADDRESS, action: "archive" } }] };
  }
  if (lastText.includes("E2E INSPECT")) {
    return { toolCalls: [{ name: "inspect_agent", arguments: { address: MOCK_WORKER_ADDRESS } }] };
  }
  if (lastText.includes("E2E SEND INVALID")) {
    return {
      toolCalls: [
        { name: "send_email", arguments: { to: "bogus-address", subject: "Bad address", message: "No side effects.", priority: "low" } },
        { name: "send_email", arguments: { to: MOCK_MAIN_ADDRESS, subject: "Self send", message: "No side effects.", priority: "low" } },
        {
          name: "send_email",
          arguments: { to: MOCK_WORKER_ADDRESS, subject: "Re: [mail_0000_fake] Bogus", message: "Unknown reference.", priority: "low" },
        },
      ],
    };
  }
  if (lastText.includes("E2E RATE")) {
    return {
      toolCalls: RATE_ADDRESSES.map((to) => ({
        name: "send_email",
        arguments: { to, subject: "Rate probe", message: "Report your two virtual email tools.", priority: "low" },
      })),
    };
  }
  if (lastText.includes("E2E DELEGATE")) {
    const slow = /SLOW (\d+)/.exec(lastText)?.[1];
    const priority = lastText.includes("HIGH") ? "high" : "low";
    const crash = lastText.includes("CRASH") ? " CRASH" : "";
    const ignore = lastText.includes("IGNORE") ? " IGNORE" : "";
    const message = slow
      ? `Simulate slow work: SLOW ${slow}.${crash}${ignore} Then report the names of your two virtual email tools.`
      : `Call fetch_emails, then report the names of your two virtual email tools.${crash}${ignore} Do not modify files.`;
    const send = (to: string): ToolCallPlan => ({
      name: "send_email",
      arguments: { to, subject: "Verify e2e mailbox", message, priority },
    });
    if (lastText.includes("BOTH")) return { toolCalls: [send(MOCK_WORKER_ADDRESS), send(MOCK_REVIEWER_ADDRESS)] };
    if (lastText.includes("REVIEWER")) return { toolCalls: [send(MOCK_REVIEWER_ADDRESS)] };
    return { toolCalls: [send(MOCK_WORKER_ADDRESS)] };
  }
  return { text: "E2E PONG" };
}

function planWorker(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const lastText = messageText(last);

  if (last?.role === "toolResult") {
    if (last.toolName === "fetch_emails") {
      const replies = unansweredPairs(lastText).map((pair) => ({
        name: "send_email",
        arguments: {
          to: pair.from,
          subject: pair.replySubject,
          message: "Worker result: virtual email tools are send_email and fetch_emails.",
          priority: "low",
        },
      }));
      // "IGNORE" requests are met with silence until the broker's enforcement
      // reminder arrives, to exercise the unanswered-obligation path.
      if (replies.length > 0 && lastText.includes("IGNORE") && !allText(messages).includes("<mailbox-enforcement")) {
        return { text: "WORKER SILENT" };
      }
      if (replies.length > 0) return { toolCalls: replies };
      return { text: "WORKER IDLE" };
    }
    if (last.toolName === "send_email") return { text: "WORKER DONE" };
    return { text: "WORKER PONG" };
  }

  if (lastText.includes("<mailbox-enforcement") || lastText.includes("<agent-email")) {
    return { toolCalls: [{ name: "fetch_emails", arguments: {} }] };
  }
  return { toolCalls: [{ name: "fetch_emails", arguments: {} }] };
}

function emptyUsage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function streamMock(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
    try {
      stream.push({ type: "start", partial: output });
      const system = context.systemPrompt ?? "";
      const messages = context.messages ?? [];
      const lastText = messageText(messages.at(-1));

      // Simulate slow work when the delivered email asks for it so tests can
      // exercise steering against a genuinely busy worker.
      const slow = /SLOW (\d+)/.exec(lastText)?.[1];
      if (slow) await sleep(Math.min(Number(slow), 15_000));
      if (options?.signal?.aborted) throw new Error("Mock stream aborted.");

      // Simulate a terminal provider failure for crash-testing worker runs.
      if (!system.includes("Main Agent Coordination") && lastText.includes("CRASH")) {
        throw new Error("Simulated provider failure.");
      }

      const plan = system.includes("Main Agent Coordination") ? planMain(messages) : planWorker(messages);
      if ("text" in plan) {
        output.content.push({ type: "text", text: "" });
        const index = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex: index, partial: output });
        (output.content[index] as { text: string }).text = plan.text;
        stream.push({ type: "text_delta", contentIndex: index, delta: plan.text, partial: output });
        stream.push({ type: "text_end", contentIndex: index, content: plan.text, partial: output });
        output.stopReason = "stop";
      } else {
        for (const call of plan.toolCalls) {
          const id = `mock_call_${output.timestamp}_${output.content.length}`;
          output.content.push({ type: "toolCall", id, name: call.name, arguments: {} });
          const index = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          const json = JSON.stringify(call.arguments);
          (output.content[index] as { arguments: unknown }).arguments = call.arguments;
          stream.push({ type: "toolcall_delta", contentIndex: index, delta: json, partial: output });
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: { type: "toolCall", id, name: call.name, arguments: call.arguments },
            partial: output,
          });
        }
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function mockE2EProvider(pi: ExtensionAPI): void {
  pi.registerProvider(MOCK_PROVIDER_ID, {
    name: "Mock E2E Provider",
    baseUrl: "http://127.0.0.1:9/mock-e2e",
    apiKey: "mock-e2e-key",
    api: "mock-e2e",
    models: [{
      id: MOCK_MODEL_ID,
      name: "Mock E2E Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    }],
    streamSimple: streamMock,
  });
}
