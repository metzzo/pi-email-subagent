import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

it("loads the packaged extension with tools, command, and renderers and no conflicts", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-extension-load-"));
  const result = await discoverAndLoadExtensions([resolve("src/index.ts")], process.cwd(), agentDir);
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find((item) => item.tools.has("send_email"));
  assert.ok(extension, "expected the pi-email-subagent extension");
  assert.deepEqual([...extension.tools.keys()].sort(), [
    "cancel_request",
    "fetch_emails",
    "inspect_agent",
    "manage_agent",
    "send_email",
    "wait_for_replies",
  ]);
  assert.equal(extension.commands.has("agents"), true);
  assert.match(extension.commands.get("agents")!.description ?? "", /offline recovery.*recover-cleanup/i);
  assert.equal(extension.shortcuts.size, 1);
  assert.equal(extension.messageRenderers.has("pi-email-subagent.email"), true);
  assert.equal(extension.messageRenderers.has("pi-email-subagent.alert"), true);

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
  const envelope = {
    id: "mail_history_render",
    from: "worker.history@gpt-5.4.com\x1b]0;title\x07",
    to: "main@gpt-5.4.com",
    subject: "History\r\nresult\x1b]52;c;clipboard\x07",
    message: "Visible \x1b[31mresult\x1b[0m body\x1b]8;;https://bad.invalid\x07link\x1b]8;;\x07",
    priority: "low" as const,
    kind: "reply" as const,
    inReplyTo: "mail_request",
    requiresResponse: false,
    createdAt: new Date().toISOString(),
    deliveryState: "delivered" as const,
  };
  const emailRenderer = extension.messageRenderers.get("pi-email-subagent.email")!;
  const emailComponent = emailRenderer({
    role: "custom", customType: "pi-email-subagent.email", content: "", display: true,
    details: envelope, timestamp: Date.now(),
  } as never, { expanded: true }, theme);
  const emailOutput = emailComponent!.render(100).join("\n");
  assert.match(emailOutput, /Conversation preview is loading.*Full transcript/s);
  assert.doesNotMatch(emailOutput, /clipboard|https:\/\/bad\.invalid|\x1b|\x07/);
  assert.match(emailOutput, /History result/);

  const enumFromOptional = (schema: unknown): string[] | undefined => {
    const typed = schema as { enum?: string[]; anyOf?: Array<{ enum?: string[] }> };
    return typed.enum ?? typed.anyOf?.find((item) => item.enum)?.enum;
  };
  const sendDefinition = extension.tools.get("send_email")!.definition;
  const sendProperties = (sendDefinition.parameters as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(enumFromOptional(sendProperties.effort), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const inspectDefinition = extension.tools.get("inspect_agent")!.definition;
  const inspectProperties = (inspectDefinition.parameters as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(enumFromOptional(inspectProperties.effort), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const callComponent = sendDefinition.renderCall!({
    to: "worker.history@gpt-5.4.com\x1b]0;recipient\x07",
    subject: "Subject\nline\x1b]52;c;secret\x07",
    message: "body",
    priority: "low",
  } as never, theme, {} as never);
  const callOutput = callComponent.render(100).join("\n");
  assert.doesNotMatch(callOutput, /recipient|secret|\x1b|\x07/);
  assert.match(callOutput, /Subject line/);

  const sendRenderer = sendDefinition.renderResult!;
  const sendComponent = sendRenderer({
    content: [{ type: "text", text: "accepted" }],
    details: {
      result: {
        envelope: { ...envelope, from: envelope.to, to: envelope.from, kind: "request", inReplyTo: undefined, requiresResponse: true },
        spawned: true,
        recipientDisposition: "spawned",
        recipientProvider: "provider-alpha",
        recipientModel: "shared",
        correlationId: "mail_history_render",
      },
    },
  } as never, { expanded: true, isPartial: false }, theme, {} as never);
  const sendOutput = sendComponent.render(100).join("\n");
  assert.match(sendOutput, /spawned · provider-alpha\/shared/);
  assert.match(sendOutput, /Conversation preview is loading.*Full transcript/s);
  assert.doesNotMatch(sendOutput, /clipboard|https:\/\/bad\.invalid|\x1b|\x07/);
});
