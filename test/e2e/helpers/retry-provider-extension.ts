/**
 * Deterministic provider used only by provider-retry E2E tests.
 * Pi owns every retry. This script never retries, re-prompts, or replays work.
 */
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RETRY_PROVIDER_ID = "mock-provider-retry";
export const RETRY_MODEL_ID = "mock-provider-retry";
export const RETRY_WORKER_ADDRESS = "worker.provider-retry@mock-provider-retry.com";

interface ToolCallPlan { name: string; arguments: Record<string, unknown> }
type Plan = { toolCalls: ToolCallPlan[] } | { text: string } | { error: string };

let toolCallSequence = 0;
let recoverAttempts = 0;
let effectRetryAttempts = 0;
let exhaustedAttempts = 0;
let allowExhaustedRecovery = false;

function messageText(message: Message | undefined): string {
  const content = message?.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

function allText(messages: readonly Message[]): string {
  return messages.map((message) => messageText(message)).join("\n");
}

function lastUserInstruction(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message);
    if (text.includes("E2E PROVIDER")) return text;
  }
  return "";
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

function unansweredPair(text: string): { from: string; replySubject: string } | undefined {
  const body = /<agent-email[^>]*>([\s\S]*?)<\/agent-email>/.exec(text)?.[1];
  if (!body) return undefined;
  const from = /<from>([^<]+)<\/from>/.exec(body)?.[1];
  const replySubject = /<reply-subject>([^<]+)<\/reply-subject>/.exec(body)?.[1];
  return from && replySubject ? { from, replySubject } : undefined;
}

function hasToolResult(messages: readonly Message[], toolName: string): boolean {
  return messages.some((message) => message?.role === "toolResult" && message.toolName === toolName);
}

function planMain(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const text = messageText(last);
  const instruction = lastUserInstruction(messages);
  const ids = correlationIds(messages);

  if (last?.role === "toolResult") {
    if (last.toolName === "send_email") {
      return { toolCalls: [{ name: "wait_for_replies", arguments: { request_ids: [ids.at(-1)], timeout_seconds: 30, collect: true } }] };
    }
    if (last.toolName === "manage_agent" && instruction.includes("RESTART")) {
      return { toolCalls: [{ name: "wait_for_replies", arguments: { request_ids: [ids.at(-1)], timeout_seconds: 30, collect: true } }] };
    }
    if (last.toolName === "wait_for_replies") {
      return { text: instruction.includes("RESTART") ? "E2E PROVIDER EXPLICIT RECOVERY COMPLETE" : instruction.includes("EXHAUST") ? "E2E PROVIDER EXHAUSTED" : "E2E PROVIDER RECOVERED" };
    }
  }

  if (text.includes("E2E PROVIDER RESTART")) {
    allowExhaustedRecovery = true;
    return { toolCalls: [{ name: "manage_agent", arguments: { address: RETRY_WORKER_ADDRESS, action: "restart" } }] };
  }
  if (text.includes("E2E PROVIDER TOOL RECOVER")) {
    const path = / PATH (\S+)/.exec(text)?.[1];
    if (!path) return { text: "E2E PROVIDER PATH MISSING" };
    return { toolCalls: [{
      name: "send_email",
      arguments: { to: RETRY_WORKER_ADDRESS, subject: "Retry after one effect", message: `RETRY_AFTER_EFFECT PATH ${path}`, priority: "low" },
    }] };
  }
  if (text.includes("E2E PROVIDER EXHAUST")) {
    const path = / PATH (\S+)/.exec(text)?.[1];
    if (!path) return { text: "E2E PROVIDER PATH MISSING" };
    return { toolCalls: [{
      name: "send_email",
      arguments: { to: RETRY_WORKER_ADDRESS, subject: "Exhaust provider retry", message: `RETRY_EXHAUST PATH ${path}`, priority: "low", effort: "high" },
    }] };
  }
  if (text.includes("E2E PROVIDER RECOVER")) {
    return { toolCalls: [{
      name: "send_email",
      arguments: { to: RETRY_WORKER_ADDRESS, subject: "Recover provider retry", message: "RETRY_RECOVER before tools", priority: "low" },
    }] };
  }
  return { text: "E2E PROVIDER READY" };
}

function replyPlan(text: string): Plan {
  const pair = unansweredPair(text);
  if (!pair) return { text: "WORKER NO OPEN MAIL" };
  return { toolCalls: [{
    name: "send_email",
    arguments: {
      to: pair.from,
      subject: pair.replySubject,
      message: "Provider retry scenario completed without replaying the accepted request.",
      priority: "low",
    },
  }] };
}

function planWorker(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const text = messageText(last);
  const history = allText(messages);

  if (last?.role === "toolResult") {
    if (last.toolName === "fetch_emails") {
      if (text.includes("RETRY_RECOVER")) {
        recoverAttempts += 1;
        if (recoverAttempts === 1) return { error: "WebSocket error: deterministic recoverable attempt" };
        return replyPlan(text);
      }
      if (text.includes("RETRY_AFTER_EFFECT")) {
        if (!hasToolResult(messages, "write")) {
          const path = /RETRY_AFTER_EFFECT PATH ([^\s<]+)/.exec(text)?.[1];
          if (!path) return { text: "WORKER EFFECT PATH MISSING" };
          return { toolCalls: [{ name: "write", arguments: { path, content: "effect occurred exactly once\n" } }] };
        }
        return replyPlan(text);
      }
      if (text.includes("RETRY_EXHAUST")) {
        if (!hasToolResult(messages, "write")) {
          const path = /RETRY_EXHAUST PATH ([^\s<]+)/.exec(text)?.[1];
          if (!path) return { text: "WORKER EXHAUST PATH MISSING" };
          return { toolCalls: [{ name: "write", arguments: { path, content: "terminal attempt effect occurred once\n" } }] };
        }
        if (!allowExhaustedRecovery) {
          exhaustedAttempts += 1;
          return { error: `fetch failed: deterministic exhausted attempt ${exhaustedAttempts}` };
        }
        return replyPlan(text);
      }
      return { text: "WORKER NO SCENARIO" };
    }
    if (last.toolName === "write") {
      if (history.includes("RETRY_AFTER_EFFECT")) {
        effectRetryAttempts += 1;
        if (effectRetryAttempts === 1) return { error: "fetch failed after one completed tool effect" };
        const fetched = [...messages].reverse().find((message) => message?.role === "toolResult" && message.toolName === "fetch_emails");
        return replyPlan(messageText(fetched));
      }
      if (history.includes("RETRY_EXHAUST")) {
        if (!allowExhaustedRecovery) {
          exhaustedAttempts += 1;
          return { error: `fetch failed: deterministic exhausted attempt ${exhaustedAttempts}` };
        }
        const fetched = [...messages].reverse().find((message) => message?.role === "toolResult" && message.toolName === "fetch_emails");
        return replyPlan(messageText(fetched));
      }
    }
    if (last.toolName === "send_email") return { text: "WORKER REPLY COMMITTED" };
  }

  if (text.includes("<agent-email") || text.includes("<mailbox-enforcement")) {
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

function streamRetryProvider(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const output = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
  const plan = (context.systemPrompt ?? "").includes("Main Agent Coordination")
    ? planMain(context.messages ?? [])
    : planWorker(context.messages ?? []);
  stream.push({ type: "start", partial: output });
  if ("error" in plan) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = plan.error;
    stream.push({ type: "error", reason: output.stopReason, error: output });
  } else if ("text" in plan) {
    output.content.push({ type: "text", text: plan.text });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: plan.text, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: plan.text, partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
  } else {
    for (const call of plan.toolCalls) {
      const id = `retry_call_${++toolCallSequence}`;
      const toolCall = { type: "toolCall" as const, id, name: call.name, arguments: call.arguments };
      output.content.push(toolCall);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }
    output.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message: output });
  }
  stream.end();
  return stream;
}

export default function retryProvider(pi: ExtensionAPI): void {
  pi.registerProvider(RETRY_PROVIDER_ID, {
    name: "Mock Provider Retry",
    baseUrl: "http://127.0.0.1:9/mock-provider-retry",
    apiKey: "deterministic-test-key",
    api: RETRY_PROVIDER_ID,
    models: [{
      id: RETRY_MODEL_ID,
      name: "Mock Provider Retry",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    }],
    streamSimple: streamRetryProvider,
  });
}
