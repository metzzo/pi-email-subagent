/** Deterministic duplicate-model providers for provider-routing RPC tests. */
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ROUTING_MODEL_ID = "shared";
export const ALPHA_PROVIDER = "mock-alpha";
export const BETA_PROVIDER = "mock-beta";
export const ALPHA_ADDRESS = "worker.alpha@shared.com";
export const BETA_ADDRESS = "worker.beta@shared.com";
export const NEW_ADDRESS = "worker.after-restart@shared.com";

interface ToolCallPlan { name: string; arguments: Record<string, unknown> }
type Plan = { toolCalls: ToolCallPlan[] } | { text: string };
let toolCallSequence = 0;

function messageText(message: Message | undefined): string {
  const content = message?.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

function lastInstruction(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message);
    if (text.includes("E2E ROUTE")) return text;
  }
  return "";
}

function lastCorrelationId(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || message.toolName !== "send_email") continue;
    return /Correlation ID: (mail_\S+)/.exec(messageText(message))?.[1];
  }
  return undefined;
}

function unanswered(text: string): { from: string; replySubject: string }[] {
  const result: { from: string; replySubject: string }[] = [];
  for (const match of text.matchAll(/<agent-email[^>]*>([\s\S]*?)<\/agent-email>/g)) {
    const from = /<from>([^<]+)<\/from>/.exec(match[1]!)?.[1];
    const replySubject = /<reply-subject>([^<]+)<\/reply-subject>/.exec(match[1]!)?.[1];
    if (from && replySubject) result.push({ from, replySubject });
  }
  return result;
}

function planMain(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const text = messageText(last);
  const instruction = lastInstruction(messages);
  if (last?.role === "toolResult") {
    if (last.toolName === "send_email") {
      if (last.isError) return { text: "E2E ROUTE SEND REJECTED" };
      const id = lastCorrelationId(messages);
      return id
        ? { toolCalls: [{ name: "wait_for_replies", arguments: { request_ids: [id], timeout_seconds: 30, collect: true } }] }
        : { text: "E2E ROUTE ID MISSING" };
    }
    if (last.toolName === "wait_for_replies") return { text: "E2E ROUTE SEND COMPLETE" };
    if (last.toolName === "manage_agent") return { text: last.isError ? "E2E ROUTE MANAGE REJECTED" : "E2E ROUTE MANAGED" };
    if (last.toolName === "inspect_agent") return { text: "E2E ROUTE INSPECTED" };
  }
  if (text.includes("E2E ROUTE SEND ALPHA")) {
    return { toolCalls: [{ name: "send_email", arguments: {
      to: ALPHA_ADDRESS, subject: "Alpha route", message: "Reply from the preserved alpha identity.", priority: "low",
    } }] };
  }
  if (text.includes("E2E ROUTE SEND BETA")) {
    return { toolCalls: [{ name: "send_email", arguments: {
      to: BETA_ADDRESS, subject: "Beta route", message: "Reply from the selected beta identity.", priority: "low",
    } }] };
  }
  if (text.includes("E2E ROUTE SEND NEW")) {
    return { toolCalls: [{ name: "send_email", arguments: {
      to: NEW_ADDRESS, subject: "New route", message: "Bind under the current main provider.", priority: "low",
    } }] };
  }
  if (text.includes("E2E ROUTE ARCHIVE ALPHA")) {
    return { toolCalls: [{ name: "manage_agent", arguments: { address: ALPHA_ADDRESS, action: "archive" } }] };
  }
  if (text.includes("E2E ROUTE RESTART ALPHA")) {
    return { toolCalls: [{ name: "manage_agent", arguments: { address: ALPHA_ADDRESS, action: "restart" } }] };
  }
  if (text.includes("E2E ROUTE INSPECT ALPHA")) {
    return { toolCalls: [{ name: "inspect_agent", arguments: { address: ALPHA_ADDRESS } }] };
  }
  if (instruction) return { text: "E2E ROUTE READY" };
  return { text: "E2E ROUTE READY" };
}

function planWorker(messages: readonly Message[]): Plan {
  const last = messages.at(-1);
  const text = messageText(last);
  if (last?.role === "toolResult") {
    if (last.toolName === "fetch_emails") {
      const pairs = unanswered(text);
      if (pairs.length === 0) return { text: "WORKER ROUTE NO OPEN MAIL" };
      return { toolCalls: pairs.map((pair) => ({
        name: "send_email",
        arguments: {
          to: pair.from,
          subject: pair.replySubject,
          message: "Durable provider routing completed.",
          priority: "low",
        },
      })) };
    }
    if (last.toolName === "send_email") return { text: "WORKER ROUTE REPLY COMMITTED" };
  }
  return { toolCalls: [{ name: "fetch_emails", arguments: {} }] };
}

function usage() {
  return {
    input: 8,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function stream(model: Model<Api>, context: Context, _options?: SimpleStreamOptions) {
  const events = createAssistantMessageEventStream();
  const output = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
  const plan = (context.systemPrompt ?? "").includes("Main Agent Coordination")
    ? planMain(context.messages ?? [])
    : planWorker(context.messages ?? []);
  events.push({ type: "start", partial: output });
  if ("text" in plan) {
    output.content.push({ type: "text", text: plan.text });
    events.push({ type: "text_start", contentIndex: 0, partial: output });
    events.push({ type: "text_delta", contentIndex: 0, delta: plan.text, partial: output });
    events.push({ type: "text_end", contentIndex: 0, content: plan.text, partial: output });
    events.push({ type: "done", reason: "stop", message: output });
  } else {
    for (const call of plan.toolCalls) {
      const id = `routing_call_${++toolCallSequence}`;
      const toolCall = { type: "toolCall" as const, id, name: call.name, arguments: call.arguments };
      output.content.push(toolCall);
      const contentIndex = output.content.length - 1;
      events.push({ type: "toolcall_start", contentIndex, partial: output });
      events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
      events.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }
    output.stopReason = "toolUse";
    events.push({ type: "done", reason: "toolUse", message: output });
  }
  events.end();
  return events;
}

function register(pi: ExtensionAPI, provider: string): void {
  pi.registerProvider(provider, {
    name: provider,
    baseUrl: `http://127.0.0.1:9/${provider}`,
    apiKey: "deterministic-routing-key",
    api: provider,
    models: [{
      id: ROUTING_MODEL_ID,
      name: `${provider} shared`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    }],
    streamSimple: stream,
  });
}

export default function duplicateModelProviders(pi: ExtensionAPI): void {
  const enabled = new Set((process.env.PI_ROUTING_PROVIDERS ?? `${ALPHA_PROVIDER},${BETA_PROVIDER}`).split(",").filter(Boolean));
  if (enabled.has(ALPHA_PROVIDER)) register(pi, ALPHA_PROVIDER);
  if (enabled.has(BETA_PROVIDER)) register(pi, BETA_PROVIDER);
}
