import type { EmailEnvelope } from "./types.ts";

/** Pure policy used by the broker façade; delivery and journal mutation stay broker-owned. */
export function isCorrelatedMainReply(
  envelope: EmailEnvelope,
  original: EmailEnvelope | undefined,
  isMainIdentity: (address: string) => boolean,
  sameIdentity: (left: string, right: string) => boolean,
): boolean {
  return Boolean(
    envelope.kind === "reply"
    && envelope.inReplyTo
    && isMainIdentity(envelope.to)
    && original
    && original.requiresResponse
    && isMainIdentity(original.from)
    && sameIdentity(original.to, envelope.from)
    && !original.answeredAt
    && original.deliveryState === "delivered",
  );
}
