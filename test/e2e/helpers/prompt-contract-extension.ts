// Exercise prompt rendering through Pi's actual extension module loader as well
// as the direct TypeScript imports used by unit tests. Both load paths occur in
// an in-process AgentSession; their V8 coverage records are distinct.
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../../src/config.ts";
import { formatEmail, mainCoordinatorPrompt } from "../../../src/prompts.ts";

export default function promptContractExtension(): void {
  const config = structuredClone(DEFAULT_CONFIG);
  config.addresses["scout.specific@model.com"] = { tools: ["read"] };
  const prompt = mainCoordinatorPrompt("main@model.com", "model", "off", ["model"], 0, config);
  assert.match(prompt, /scout\.specific@model\.com: read, send_email, fetch_emails \(read-only\)/);
  const reply = formatEmail({
    id: "mail_reply", from: "scout.specific@model.com", to: "main@model.com", subject: "Re: result",
    message: "Finished", priority: "low", kind: "reply", inReplyTo: "mail_request", requiresResponse: false,
    createdAt: "2026-09-07T00:00:00.000Z", deliveryState: "delivered",
    completion: { status: "completed", summary: "Checked", artifacts: ["src/a.ts"], validation: ["tests passed"], remaining: [] },
  });
  assert.match(reply, /<artifacts><item>src\/a\.ts<\/item><\/artifacts>/);
}
