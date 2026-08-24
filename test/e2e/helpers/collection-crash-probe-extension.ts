import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piEmailSubagentExtension from "../../../src/index.ts";
import { AgentBroker } from "../../../src/broker.ts";
import { MailStore } from "../../../src/mail-store.ts";
import type { EmailEnvelope } from "../../../src/types.ts";

const boundary = process.env.PI_EMAIL_COLLECTION_PROBE_BOUNDARY;
const markerPath = process.env.PI_EMAIL_COLLECTION_PROBE_MARKER;

function mark(name: string, details: Record<string, unknown>): void {
  if (boundary !== name || !markerPath) return;
  writeFileSync(markerPath, `${JSON.stringify({ boundary: name, ...details })}\n`, { mode: 0o600 });
}

async function hold(): Promise<never> {
  return new Promise<never>(() => undefined);
}

if (boundary === "reply-reserved") {
  const prototype = MailStore.prototype as MailStore & {
    reserveReply(reply: EmailEnvelope, originalId: string): Promise<void>;
  };
  const reserveReply = prototype.reserveReply;
  prototype.reserveReply = async function patchedReserveReply(reply: EmailEnvelope, originalId: string): Promise<void> {
    await reserveReply.call(this, reply, originalId);
    mark("reply-reserved", { requestId: originalId, replyId: reply.id });
    await hold();
  };
}

if (boundary === "claim-acquired") {
  const prototype = AgentBroker.prototype as unknown as {
    claimCollection(envelope: EmailEnvelope): string | undefined;
  };
  const claimCollection = prototype.claimCollection;
  prototype.claimCollection = function patchedClaimCollection(envelope: EmailEnvelope): string | undefined {
    const requestId = claimCollection.call(this, envelope);
    if (requestId) {
      mark("claim-acquired", { requestId, replyId: envelope.id });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return requestId;
  };
}

if (boundary === "answer-committed") {
  const prototype = MailStore.prototype as MailStore & {
    markDelivered(ids: readonly string[]): Promise<void>;
  };
  const markDelivered = prototype.markDelivered;
  prototype.markDelivered = async function patchedMarkDelivered(ids: readonly string[]): Promise<void> {
    await markDelivered.call(this, ids);
    const reply = ids.map((id) => this.get(id)).find((email) => email?.kind === "reply");
    if (reply?.inReplyTo) {
      mark("answer-committed", { requestId: reply.inReplyTo, replyId: reply.id });
      await hold();
    }
  };
}

export default function collectionCrashProbe(pi: ExtensionAPI): void {
  if (boundary === "execute-resolved") {
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "wait_for_replies") return;
      const result = (event.details as { result?: { items?: Array<{ requestId?: string; reply?: { id?: string } }> } } | undefined)?.result;
      const item = result?.items?.[0];
      mark("execute-resolved", { requestId: item?.requestId, replyId: item?.reply?.id });
      await hold();
    });
  }
  piEmailSubagentExtension(pi);
}
