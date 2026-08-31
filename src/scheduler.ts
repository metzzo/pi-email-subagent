import type { EmailEnvelope } from "./types.ts";

export function pendingRank(address: string, mail: readonly EmailEnvelope[], now = Date.now()): [number, string, string] {
  const ordered = [...mail].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const oldest = ordered[0]?.createdAt ?? "9999";
  const aged = ordered.some((email) => now - Date.parse(email.createdAt) >= 30_000);
  const high = ordered.some((email) => email.priority === "high");
  return [aged || high ? 0 : 1, oldest, address];
}

export function takeNextPending(
  pending: string[],
  mailFor: (address: string) => readonly EmailEnvelope[],
): string | undefined {
  const ranked = pending
    .map((address, index) => ({ address, index, rank: pendingRank(address, mailFor(address)) }))
    .sort((left, right) => left.rank[0] - right.rank[0]
      || left.rank[1].localeCompare(right.rank[1])
      || left.rank[2].localeCompare(right.rank[2]))[0];
  if (!ranked) return undefined;
  pending.splice(ranked.index, 1);
  return ranked.address;
}
