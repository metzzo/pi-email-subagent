import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { EmailEnvelope } from "./types.ts";
import { byteLength, clone, nowIso } from "./util.ts";

type MailEvent =
  | { type: "email.created"; email: EmailEnvelope }
  | { type: "email.delivered"; id: string; at: string }
  | { type: "email.failed"; id: string; at: string; error: string }
  | { type: "email.reply_reserved"; id: string; replyId: string; at: string }
  | { type: "email.reply_released"; id: string; replyId: string; at: string; error: string }
  | { type: "email.answered"; id: string; replyId: string; at: string };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, label);
}

function parseEmail(value: unknown): EmailEnvelope {
  const raw = object(value, "email");
  const priority = raw.priority;
  const kind = raw.kind;
  const deliveryState = raw.deliveryState;
  if (priority !== "high" && priority !== "low") throw new Error("email.priority is invalid.");
  if (kind !== "request" && kind !== "reply") throw new Error("email.kind is invalid.");
  if (deliveryState !== "queued" && deliveryState !== "delivered" && deliveryState !== "failed") {
    throw new Error("email.deliveryState is invalid.");
  }
  if (typeof raw.requiresResponse !== "boolean") throw new Error("email.requiresResponse must be boolean.");
  const email: EmailEnvelope = {
    id: string(raw.id, "email.id"),
    from: string(raw.from, "email.from"),
    to: string(raw.to, "email.to"),
    subject: string(raw.subject, "email.subject"),
    message: string(raw.message, "email.message"),
    priority,
    kind,
    requiresResponse: raw.requiresResponse,
    createdAt: string(raw.createdAt, "email.createdAt"),
    deliveryState,
  };
  for (const [key, label] of [
    ["inReplyTo", "email.inReplyTo"],
    ["deliveredAt", "email.deliveredAt"],
    ["answeredAt", "email.answeredAt"],
    ["answeredBy", "email.answeredBy"],
    ["replyReservedBy", "email.replyReservedBy"],
    ["replyReservedAt", "email.replyReservedAt"],
    ["error", "email.error"],
  ] as const) {
    const parsed = optionalString(raw[key], label);
    if (parsed !== undefined) (email as unknown as Record<string, unknown>)[key] = parsed;
  }
  if (email.kind === "reply" && !email.inReplyTo) throw new Error("reply email is missing inReplyTo.");
  if (email.kind === "reply" && email.requiresResponse) throw new Error("reply email cannot require a response.");
  return email;
}

function parseEvent(value: unknown): MailEvent {
  const raw = object(value, "mail event");
  const type = string(raw.type, "mail event.type");
  if (type === "email.created") return { type, email: parseEmail(raw.email) };
  if (type === "email.delivered") {
    return { type, id: string(raw.id, "mail event.id"), at: string(raw.at, "mail event.at") };
  }
  if (type === "email.failed") {
    return {
      type,
      id: string(raw.id, "mail event.id"),
      at: string(raw.at, "mail event.at"),
      error: string(raw.error, "mail event.error"),
    };
  }
  if (type === "email.reply_reserved" || type === "email.answered") {
    return {
      type,
      id: string(raw.id, "mail event.id"),
      replyId: string(raw.replyId, "mail event.replyId"),
      at: string(raw.at, "mail event.at"),
    };
  }
  if (type === "email.reply_released") {
    return {
      type,
      id: string(raw.id, "mail event.id"),
      replyId: string(raw.replyId, "mail event.replyId"),
      at: string(raw.at, "mail event.at"),
      error: string(raw.error, "mail event.error"),
    };
  }
  throw new Error(`unknown event type ${JSON.stringify(type)}.`);
}

function sameCreatedEmail(left: EmailEnvelope, right: EmailEnvelope): boolean {
  return left.id === right.id
    && left.from === right.from
    && left.to === right.to
    && left.subject === right.subject
    && left.message === right.message
    && left.priority === right.priority
    && left.kind === right.kind
    && left.inReplyTo === right.inReplyTo
    && left.requiresResponse === right.requiresResponse
    && left.createdAt === right.createdAt;
}

// Rewrite the journal as a snapshot once it grows past this many events.
export const MAIL_JOURNAL_COMPACT_THRESHOLD = 8192;

export class MailStore {
  private readonly emails = new Map<string, EmailEnvelope>();
  private writeChain: Promise<void> = Promise.resolve();
  private maintenancePromise?: Promise<boolean>;
  private eventCount = 0;

  constructor(readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { await chmod(dirname(this.path), 0o700); } catch { /* unsupported platform */ }
    if (!existsSync(this.path)) return;
    const raw = await readFile(this.path, "utf8");
    const lines = raw.split("\n");
    const validLines: string[] = [];
    let repairedTrailingWrite = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const isLastContent = lines.slice(index + 1).every((remaining) => !remaining.trim());
        if (!isLastContent) throw new Error(`Corrupt mail journal at line ${index + 1}: ${String(error)}`);
        repairedTrailingWrite = true;
        continue;
      }
      try {
        this.apply(parseEvent(parsed));
        validLines.push(line);
      } catch (error) {
        throw new Error(`Corrupt mail journal at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (repairedTrailingWrite) {
      await writeFile(this.path, validLines.length > 0 ? `${validLines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    }
    try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }

    const orphanReservations: MailEvent[] = [];
    const plannedOriginals = new Set<string>();
    for (const reply of [...this.emails.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (reply.kind !== "reply" || !reply.inReplyTo) continue;
      const original = this.emails.get(reply.inReplyTo);
      if (!original || !original.requiresResponse || original.deliveryState !== "delivered"
        || original.answeredAt || original.replyReservedBy || plannedOriginals.has(original.id)) continue;
      orphanReservations.push({ type: "email.reply_reserved", id: original.id, replyId: reply.id, at: reply.createdAt });
      plannedOriginals.add(original.id);
    }
    if (orphanReservations.length > 0) await this.transact(() => orphanReservations);

    const repairs: MailEvent[] = [];
    for (const original of this.emails.values()) {
      if (!original.replyReservedBy || original.answeredAt) continue;
      const reply = this.emails.get(original.replyReservedBy);
      if (reply?.deliveryState === "delivered") {
        repairs.push({ type: "email.answered", id: original.id, replyId: reply.id, at: reply.deliveredAt ?? nowIso() });
      } else if (!reply || reply.deliveryState === "failed") {
        repairs.push({
          type: "email.reply_released",
          id: original.id,
          replyId: original.replyReservedBy,
          at: nowIso(),
          error: reply?.error ?? "Reserved reply was missing during recovery.",
        });
      }
    }
    if (repairs.length > 0) await this.transact(() => repairs);
  }

  private apply(event: MailEvent): void {
    this.eventCount += 1;
    if (event.type === "email.created") {
      const existing = this.emails.get(event.email.id);
      if (existing && !sameCreatedEmail(existing, event.email)) throw new Error(`Conflicting duplicate email ${event.email.id}.`);
      if (!existing) this.emails.set(event.email.id, clone(event.email));
      return;
    }

    const email = this.emails.get(event.id);
    if (!email) throw new Error(`Journal event references unknown email ${event.id}.`);
    if (event.type === "email.delivered") {
      if (email.deliveryState === "delivered") return;
      if (email.deliveryState === "failed") throw new Error(`Cannot deliver failed email ${email.id}.`);
      email.deliveryState = "delivered";
      email.deliveredAt = event.at;
      delete email.error;
      return;
    }
    if (event.type === "email.failed") {
      if (email.deliveryState === "failed" && email.error === event.error) return;
      if (email.answeredAt) throw new Error(`Cannot fail answered email ${email.id}.`);
      email.deliveryState = "failed";
      email.error = event.error;
      return;
    }
    if (event.type === "email.reply_reserved") {
      const reply = this.emails.get(event.replyId);
      if (!email.requiresResponse || email.deliveryState !== "delivered") {
        throw new Error(`Email ${email.id} is not an open delivered obligation.`);
      }
      if (!reply || reply.kind !== "reply" || reply.inReplyTo !== email.id) {
        throw new Error(`Reservation reply ${event.replyId} does not target ${email.id}.`);
      }
      if (email.answeredBy === event.replyId) return;
      if (email.answeredAt) throw new Error(`${email.id} was already answered by ${email.answeredBy}.`);
      if (email.replyReservedBy && email.replyReservedBy !== event.replyId) {
        throw new Error(`${email.id} already has reply ${email.replyReservedBy} pending delivery.`);
      }
      email.replyReservedBy = event.replyId;
      email.replyReservedAt = event.at;
      return;
    }
    if (event.type === "email.reply_released") {
      if (!email.replyReservedBy && !email.answeredAt) return;
      if (email.replyReservedBy !== event.replyId) {
        throw new Error(`Reply ${event.replyId} does not hold reservation for ${email.id}.`);
      }
      delete email.replyReservedBy;
      delete email.replyReservedAt;
      return;
    }

    const reply = this.emails.get(event.replyId);
    if (email.answeredBy === event.replyId) return;
    if (!reply || reply.kind !== "reply" || reply.inReplyTo !== email.id) {
      throw new Error(`Answer reply ${event.replyId} does not target ${email.id}.`);
    }
    // Journals written before reply reservations recorded email.answered before
    // delivery. Migrate that event into a reservation; the recovery pass below
    // commits it only if the reply is delivered, or releases it if it failed.
    if (!email.replyReservedBy) {
      if (email.answeredAt) throw new Error(`${email.id} was already answered by ${email.answeredBy}.`);
      email.replyReservedBy = event.replyId;
      email.replyReservedAt = event.at;
      if (reply.deliveryState !== "delivered") return;
    }
    if (email.replyReservedBy !== event.replyId) {
      throw new Error(`Reply ${event.replyId} does not hold reservation for ${email.id}.`);
    }
    if (reply.deliveryState !== "delivered") {
      throw new Error(`Reply ${event.replyId} was not delivered before answering ${email.id}.`);
    }
    email.answeredAt = event.at;
    email.answeredBy = event.replyId;
    delete email.replyReservedBy;
    delete email.replyReservedAt;
  }

  private async transact(build: () => MailEvent[]): Promise<void> {
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const events = build();
      if (events.length === 0) return;
      const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await appendFile(this.path, payload, { encoding: "utf8", mode: 0o600 });
      try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
      for (const event of events) this.apply(event);
    });
    this.writeChain = operation;
    await operation;
  }

  async accept(email: EmailEnvelope): Promise<void> {
    await this.transact(() => {
      const existing = this.emails.get(email.id);
      if (existing) {
        if (!sameCreatedEmail(existing, email)) throw new Error(`Conflicting duplicate email ${email.id}.`);
        return [];
      }
      return [{ type: "email.created", email: clone(email) }];
    });
  }

  async reserveReply(reply: EmailEnvelope, originalId: string): Promise<void> {
    await this.transact(() => {
      if (this.emails.has(reply.id)) throw new Error(`Email ${reply.id} already exists.`);
      const original = this.emails.get(originalId);
      if (!original) throw new Error(`Reply references unknown email ${originalId}.`);
      if (!original.requiresResponse) throw new Error(`${originalId} is a reply and does not require an answer.`);
      if (original.deliveryState !== "delivered") throw new Error(`${originalId} has not been delivered yet.`);
      if (original.answeredAt) throw new Error(`${originalId} was already answered by ${original.answeredBy}.`);
      if (original.replyReservedBy) {
        throw new Error(`${originalId} already has reply ${original.replyReservedBy} pending delivery.`);
      }
      return [
        { type: "email.created", email: clone(reply) },
        { type: "email.reply_reserved", id: originalId, replyId: reply.id, at: nowIso() },
      ];
    });
  }

  async markDelivered(ids: readonly string[]): Promise<void> {
    await this.transact(() => {
      const at = nowIso();
      const events: MailEvent[] = [];
      for (const id of ids) {
        const email = this.emails.get(id);
        if (!email || email.deliveryState !== "queued") continue;
        events.push({ type: "email.delivered", id, at });
        if (email.kind === "reply" && email.inReplyTo) {
          const original = this.emails.get(email.inReplyTo);
          if (original?.replyReservedBy === email.id && !original.answeredAt) {
            events.push({ type: "email.answered", id: original.id, replyId: email.id, at });
          }
        }
      }
      return events;
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.transact(() => {
      const email = this.emails.get(id);
      if (!email) throw new Error(`Unknown email ${id}.`);
      if (email.deliveryState === "failed") return [];
      const at = nowIso();
      const events: MailEvent[] = [{ type: "email.failed", id, at, error }];
      if (email.kind === "reply" && email.inReplyTo) {
        const original = this.emails.get(email.inReplyTo);
        if (original?.replyReservedBy === email.id && !original.answeredAt) {
          events.push({ type: "email.reply_released", id: original.id, replyId: email.id, at, error });
        }
      }
      return events;
    });
  }

  get(id: string): EmailEnvelope | undefined {
    const email = this.emails.get(id);
    return email ? clone(email) : undefined;
  }

  getReplyFor(originalId: string): EmailEnvelope | undefined {
    const original = this.emails.get(originalId);
    if (!original?.answeredBy) return undefined;
    return this.get(original.answeredBy);
  }

  list(): EmailEnvelope[] {
    return [...this.emails.values()].map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  unanswered(recipient: string, deliveredOnly = true): EmailEnvelope[] {
    return [...this.emails.values()]
      .filter((email) =>
        email.to === recipient &&
        email.requiresResponse &&
        !email.answeredAt &&
        !email.replyReservedBy &&
        (!deliveredOnly || email.deliveryState === "delivered"),
      )
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map(clone);
  }

  queued(recipient: string): EmailEnvelope[] {
    return [...this.emails.values()]
      .filter((email) => email.to === recipient && email.deliveryState === "queued")
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map(clone);
  }

  queuedMetrics(recipient: string): { count: number; bytes: number } {
    const queued = this.queued(recipient);
    return {
      count: queued.length,
      bytes: queued.reduce((total, email) => total + byteLength(email.subject) + byteLength(email.message), 0),
    };
  }

  countQueued(): number {
    return [...this.emails.values()].filter((email) => email.deliveryState === "queued").length;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private retainedSnapshot(maxRetainedEmails: number): EmailEnvelope[] {
    const all = [...this.emails.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (all.length <= maxRetainedEmails) return all.map(clone);

    const keep = new Set<string>();
    const protectRelations = (email: EmailEnvelope): void => {
      keep.add(email.id);
      if (email.inReplyTo && this.emails.has(email.inReplyTo)) keep.add(email.inReplyTo);
      if (email.answeredBy && this.emails.has(email.answeredBy)) keep.add(email.answeredBy);
      if (email.replyReservedBy && this.emails.has(email.replyReservedBy)) keep.add(email.replyReservedBy);
    };
    for (const email of all) {
      const open = email.deliveryState === "queued"
        || (email.requiresResponse && email.deliveryState === "delivered" && !email.answeredAt)
        || Boolean(email.replyReservedBy);
      if (open) protectRelations(email);
    }
    // Relation expansion preserves answered request/reply pairs selected from
    // either side and queued reply/original pairs.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const id of [...keep]) {
        const before = keep.size;
        const email = this.emails.get(id);
        if (email) protectRelations(email);
        if (keep.size !== before) expanded = true;
      }
    }
    for (let index = all.length - 1; index >= 0 && keep.size < maxRetainedEmails; index -= 1) {
      protectRelations(all[index]!);
    }
    return all.filter((email) => keep.has(email.id)).map(clone);
  }

  private async rewriteSnapshot(emails: readonly EmailEnvelope[]): Promise<void> {
    const events: MailEvent[] = emails.map((email) => ({ type: "email.created", email: clone(email) }));
    const payload = events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
    try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
    this.emails.clear();
    for (const email of emails) this.emails.set(email.id, clone(email));
    this.eventCount = events.length;
  }

  /** Rewrite the journal as one full-state `email.created` snapshot per retained envelope. */
  async compact(): Promise<void> {
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      await this.rewriteSnapshot([...this.emails.values()]);
    });
    this.writeChain = operation;
    await operation;
  }

  async maintainIfNeeded(
    threshold = MAIL_JOURNAL_COMPACT_THRESHOLD,
    maxRetainedEmails = Number.MAX_SAFE_INTEGER,
  ): Promise<boolean> {
    if (this.maintenancePromise) return this.maintenancePromise;
    const excessEvents = this.eventCount - this.emails.size;
    if (excessEvents <= threshold && this.emails.size <= maxRetainedEmails) return false;
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const currentExcess = this.eventCount - this.emails.size;
      if (currentExcess <= threshold && this.emails.size <= maxRetainedEmails) return false;
      await this.rewriteSnapshot(this.retainedSnapshot(maxRetainedEmails));
      return true;
    });
    const write = operation.then(() => undefined);
    this.writeChain = write;
    const tracked = operation.finally(() => {
      if (this.maintenancePromise === tracked) this.maintenancePromise = undefined;
    });
    this.maintenancePromise = tracked;
    return tracked;
  }

  async compactIfNeeded(threshold = MAIL_JOURNAL_COMPACT_THRESHOLD): Promise<boolean> {
    return this.maintainIfNeeded(threshold);
  }
}
