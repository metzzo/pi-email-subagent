import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseSubagentAddressShape } from "./address.ts";
import { isThinkingLevel, LIFECYCLE_FIELDS, MAX_TIMER_DELAY_MS } from "./config.ts";
import type { EmailEnvelope, LifecyclePolicy, ModelBinding, ReplyCompletion, ReplyStatus } from "./types.ts";
import { byteLength, clone, nowIso } from "./util.ts";

export type MailEvent =
  | { type: "email.created"; email: EmailEnvelope }
  | { type: "email.delivered"; id: string; at: string }
  | { type: "email.failed"; id: string; at: string; error: string }
  | { type: "email.cancelled"; id: string; at: string; by: string; reason: string }
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

function parseModelBinding(value: unknown, recipient: string): ModelBinding | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, "email.modelBindingIntent");
  const provider = string(raw.provider, "email.modelBindingIntent.provider");
  const modelId = string(raw.modelId, "email.modelBindingIntent.modelId");
  if (!provider.trim()) throw new Error("email.modelBindingIntent.provider must be a non-empty string.");
  if (!modelId.trim()) throw new Error("email.modelBindingIntent.modelId must be a non-empty string.");
  let recipientModelId: string;
  try {
    recipientModelId = parseSubagentAddressShape(recipient).modelId;
  } catch {
    throw new Error("email.modelBindingIntent is allowed only for a valid subagent recipient.");
  }
  if (recipientModelId.toLowerCase() !== modelId.toLowerCase()) {
    throw new Error(`email.modelBindingIntent.modelId "${modelId}" does not match recipient model domain "${recipientModelId}".`);
  }
  return { provider, modelId };
}

function parseLifecycle(value: unknown, label: string): LifecyclePolicy | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  const result = {} as LifecyclePolicy;
  for (const key of LIFECYCLE_FIELDS) {
    const candidate = raw[key];
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_TIMER_DELAY_MS) {
      throw new Error(`${label}.${key} must be an integer from 1 to ${MAX_TIMER_DELAY_MS} (the runtime-safe timer maximum).`);
    }
    result[key] = candidate as number;
  }
  return result;
}

function parseReplyCompletion(value: unknown): ReplyCompletion | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, "email.completion");
  const status = raw.status as ReplyStatus;
  if (status !== "completed" && status !== "partial" && status !== "blocked") {
    throw new Error("email.completion.status is invalid.");
  }
  const list = (key: "artifacts" | "validation" | "remaining"): string[] => {
    const value = raw[key];
    if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`email.completion.${key} is invalid.`);
    }
    return [...value];
  };
  return {
    status,
    summary: string(raw.summary, "email.completion.summary"),
    artifacts: list("artifacts"),
    validation: list("validation"),
    remaining: list("remaining"),
    ...(raw.warning === undefined ? {} : { warning: string(raw.warning, "email.completion.warning") }),
  };
}

function parseEmail(value: unknown): EmailEnvelope {
  const raw = object(value, "email");
  const priority = raw.priority;
  const kind = raw.kind;
  const deliveryState = raw.deliveryState;
  if (priority !== "high" && priority !== "low") throw new Error("email.priority is invalid.");
  if (kind !== "request" && kind !== "reply" && kind !== "notification") throw new Error("email.kind is invalid.");
  if (deliveryState !== "queued" && deliveryState !== "delivered" && deliveryState !== "failed" && deliveryState !== "cancelled") {
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
    ["cancelledAt", "email.cancelledAt"],
    ["cancelledBy", "email.cancelledBy"],
    ["cancellationReason", "email.cancellationReason"],
  ] as const) {
    const parsed = optionalString(raw[key], label);
    if (parsed !== undefined) (email as unknown as Record<string, unknown>)[key] = parsed;
  }
  const completion = parseReplyCompletion(raw.completion);
  if (completion) email.completion = completion;
  const lifecycleIntent = parseLifecycle(raw.lifecycleIntent, "email.lifecycleIntent");
  if (lifecycleIntent) email.lifecycleIntent = lifecycleIntent;
  const modelBindingIntent = parseModelBinding(raw.modelBindingIntent, email.to);
  if (modelBindingIntent) {
    if (email.kind === "reply") {
      throw new Error("email.modelBindingIntent is not allowed on a reply.");
    }
    email.modelBindingIntent = modelBindingIntent;
  }
  const effortIntent = optionalString(raw.effortIntent, "email.effortIntent");
  if (effortIntent !== undefined) {
    if (!isThinkingLevel(effortIntent)) throw new Error("email.effortIntent is invalid.");
    email.effortIntent = effortIntent;
  }
  if (email.kind === "reply" && !email.inReplyTo) throw new Error("reply email is missing inReplyTo.");
  if (email.kind === "reply" && email.requiresResponse) throw new Error("reply email cannot require a response.");
  if (email.kind !== "reply" && email.completion) throw new Error("only a reply email can contain completion metadata.");
  if (email.kind === "notification" && email.requiresResponse) throw new Error("notification email cannot require a response.");
  if (email.deliveryState === "cancelled"
    && (!email.cancelledAt || !email.cancelledBy || !email.cancellationReason)) {
    throw new Error("cancelled email is missing cancellation audit metadata.");
  }
  return email;
}

export function parseMailEvent(value: unknown): MailEvent {
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
  if (type === "email.cancelled") {
    return {
      type,
      id: string(raw.id, "mail event.id"),
      at: string(raw.at, "mail event.at"),
      by: string(raw.by, "mail event.by"),
      reason: string(raw.reason, "mail event.reason"),
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
    && JSON.stringify(left.completion) === JSON.stringify(right.completion)
    && left.requiresResponse === right.requiresResponse
    && left.createdAt === right.createdAt
    && JSON.stringify(left.lifecycleIntent) === JSON.stringify(right.lifecycleIntent)
    && left.effortIntent === right.effortIntent
    && left.modelBindingIntent?.provider === right.modelBindingIntent?.provider
    && left.modelBindingIntent?.modelId === right.modelBindingIntent?.modelId;
}

// Rewrite the journal as a snapshot once it grows past this many events.
export const MAIL_JOURNAL_COMPACT_THRESHOLD = 8192;

class MailJournalPoisonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailJournalPoisonError";
  }
}

export class MailStore {
  private readonly emails = new Map<string, EmailEnvelope>();
  private writeChain: Promise<void> = Promise.resolve();
  private poison?: MailJournalPoisonError;
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
        this.apply(parseMailEvent(parsed));
        validLines.push(line);
      } catch (error) {
        throw new Error(`Corrupt mail journal at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (repairedTrailingWrite) {
      await this.replaceJournal(validLines.length > 0 ? `${validLines.join("\n")}\n` : "");
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
      if (email.deliveryState === "failed" || email.deliveryState === "cancelled") {
        throw new Error(`Cannot deliver ${email.deliveryState} email ${email.id}.`);
      }
      email.deliveryState = "delivered";
      email.deliveredAt = event.at;
      delete email.error;
      return;
    }
    if (event.type === "email.failed") {
      if (email.deliveryState === "cancelled") return;
      if (email.deliveryState === "failed" && email.error === event.error) return;
      const original = email.kind === "reply" && email.inReplyTo ? this.emails.get(email.inReplyTo) : undefined;
      if (email.kind === "reply" && (email.deliveryState === "delivered" || original?.answeredBy === email.id)) return;
      if (email.answeredAt) throw new Error(`Cannot fail answered email ${email.id}.`);
      email.deliveryState = "failed";
      email.error = event.error;
      return;
    }
    if (event.type === "email.cancelled") {
      if (email.deliveryState === "cancelled") {
        if (email.cancelledAt === event.at && email.cancelledBy === event.by && email.cancellationReason === event.reason) return;
        throw new Error(`Email ${email.id} has conflicting cancellation metadata.`);
      }
      if (!email.requiresResponse || email.kind !== "request") throw new Error(`Email ${email.id} has no response obligation to cancel.`);
      if (email.answeredAt) throw new Error(`Cannot cancel answered email ${email.id}.`);
      if (email.replyReservedBy) throw new Error(`Cannot cancel ${email.id} while reply ${email.replyReservedBy} is pending delivery.`);
      if (email.deliveryState === "failed") throw new Error(`Cannot cancel failed email ${email.id}.`);
      email.deliveryState = "cancelled";
      email.cancelledAt = event.at;
      email.cancelledBy = event.by;
      email.cancellationReason = event.reason;
      delete email.error;
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
      if (email.answeredBy === event.replyId) return;
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

  /** Narrow append boundary for durability fault tests; production uses one open file descriptor. */
  protected async appendJournalPayload(handle: FileHandle, payload: string): Promise<void> {
    await handle.writeFile(payload, { encoding: "utf8" });
  }

  private async appendJournal(payload: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "a+", 0o600);
    } catch (error) {
      throw new MailJournalPoisonError("Mail journal append could not open its file; this store is poisoned until restart.", { cause: error });
    }
    let offset: number | undefined;
    try {
      offset = (await handle.stat()).size;
      await this.appendJournalPayload(handle, payload);
    } catch (error) {
      let rollbackError: unknown;
      if (offset !== undefined) {
        try {
          await handle.truncate(offset);
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      const detail = offset === undefined
        ? " The pre-append offset could not be established."
        : rollbackError
          ? ` Append rollback to byte ${offset} also failed: ${String(rollbackError)}`
          : ` The journal was rolled back to byte ${offset}.`;
      throw new MailJournalPoisonError(`Mail journal append failed; this store is poisoned until restart.${detail}`, { cause: error });
    } finally {
      await handle.close().catch(() => undefined);
    }
    try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
  }

  private preserveAppendPoison(operation: Promise<void>): Promise<void> {
    return operation.catch((error: unknown) => {
      if (error instanceof MailJournalPoisonError) this.poison = error;
      // Validation and atomic-replacement failures do not imply a torn append.
      // Their individual caller still receives the rejection. The serialization
      // tail stays handled; poison is checked explicitly by every later caller.
    });
  }

  private async transact(build: () => MailEvent[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      if (this.poison) throw this.poison;
      const events = build();
      if (events.length === 0) return;
      const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await this.appendJournal(payload);
      for (const event of events) this.apply(event);
    });
    // Only an append failure remains the head of the chain. No later operation
    // may follow a possibly torn append or mutate memory until restart.
    this.writeChain = this.preserveAppendPoison(operation);
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

  async cancelRequest(id: string, by: string, reason: string): Promise<EmailEnvelope> {
    await this.transact(() => {
      const email = this.emails.get(id);
      if (!email) throw new Error(`Unknown email ${id}.`);
      if (email.deliveryState === "cancelled") return [];
      if (!email.requiresResponse || email.kind !== "request") throw new Error(`${id} has no response obligation to cancel.`);
      if (email.answeredAt) throw new Error(`${id} was already answered by ${email.answeredBy}.`);
      if (email.replyReservedBy) throw new Error(`${id} already has reply ${email.replyReservedBy} pending delivery.`);
      if (email.deliveryState === "failed") throw new Error(`${id} already failed delivery.`);
      return [{ type: "email.cancelled", id, at: nowIso(), by, reason }];
    });
    return this.get(id)!;
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
      if (email.deliveryState === "failed" || email.deliveryState === "cancelled") return [];
      const original = email.kind === "reply" && email.inReplyTo ? this.emails.get(email.inReplyTo) : undefined;
      if (email.kind === "reply" && (email.deliveryState === "delivered" || original?.answeredBy === email.id)) return [];
      const at = nowIso();
      const events: MailEvent[] = [{ type: "email.failed", id, at, error }];
      if (original && email.kind === "reply") {
        if (original.replyReservedBy === email.id && !original.answeredAt) {
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
    if (this.poison) throw this.poison;
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

  protected async beforeJournalReplace(): Promise<void> {}

  private async replaceJournal(payload: string): Promise<void> {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { await chmod(temp, 0o600); } catch { /* unsupported platform */ }
      await this.beforeJournalReplace();
      await rename(temp, this.path);
      try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async rewriteSnapshot(emails: readonly EmailEnvelope[]): Promise<void> {
    const events: MailEvent[] = emails.map((email) => ({ type: "email.created", email: clone(email) }));
    const payload = events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    await this.replaceJournal(payload);
    this.emails.clear();
    for (const email of emails) this.emails.set(email.id, clone(email));
    this.eventCount = events.length;
  }

  /** Rewrite the journal as one full-state `email.created` snapshot per retained envelope. */
  async compact(): Promise<void> {
    const operation = this.writeChain.then(async () => {
      if (this.poison) throw this.poison;
      await this.rewriteSnapshot([...this.emails.values()]);
    });
    this.writeChain = this.preserveAppendPoison(operation);
    await operation;
  }

  async maintainIfNeeded(
    threshold = MAIL_JOURNAL_COMPACT_THRESHOLD,
    maxRetainedEmails = Number.MAX_SAFE_INTEGER,
  ): Promise<boolean> {
    if (this.poison) throw this.poison;
    if (this.maintenancePromise) return this.maintenancePromise;
    const excessEvents = this.eventCount - this.emails.size;
    if (excessEvents <= threshold && this.emails.size <= maxRetainedEmails) return false;
    const operation = this.writeChain.then(async () => {
      if (this.poison) throw this.poison;
      const currentExcess = this.eventCount - this.emails.size;
      if (currentExcess <= threshold && this.emails.size <= maxRetainedEmails) return false;
      await this.rewriteSnapshot(this.retainedSnapshot(maxRetainedEmails));
      return true;
    });
    const write = operation.then(() => undefined);
    this.writeChain = this.preserveAppendPoison(write);
    const tracked = operation.finally(() => {
      if (this.maintenancePromise === tracked) this.maintenancePromise = undefined;
    });
    this.maintenancePromise = tracked;
    return tracked;
  }
}
