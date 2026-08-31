import * as PiAi from "@earendil-works/pi-ai";
import * as TypeBox from "typebox";
import { EFFORT_LEVELS, MAX_REPLY_WAIT_SECONDS, MAX_TIMER_DELAY_MS } from "./config.ts";

const { Type } = TypeBox;

export const PrioritySchema = PiAi.StringEnum(["high", "low"] as const);
export const EffortSchema = PiAi.StringEnum(EFFORT_LEVELS);
export const ReplyStatusSchema = PiAi.StringEnum(["completed", "partial", "blocked"] as const);
export const MAX_COMPLETION_SUMMARY_BYTES = 4_096;
export const MAX_COMPLETION_ENTRY_BYTES = 2_048;
export const MAX_COMPLETION_ENTRIES = 32;

export const LifecycleOverrideSchema = Type.Object({
  spawnTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  promptAcceptanceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  runTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  idleTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  abortTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  disposeTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
}, { additionalProperties: false, description: "Optional finite deadlines for a newly created recipient only; configured administrative maxima apply" });

export const ReplyCompletionSchema = Type.Object({
  status: ReplyStatusSchema,
  summary: Type.String({ minLength: 1, description: `Maximum ${MAX_COMPLETION_SUMMARY_BYTES} UTF-8 bytes` }),
  artifacts: Type.Array(Type.String({ minLength: 1, description: `Maximum ${MAX_COMPLETION_ENTRY_BYTES} UTF-8 bytes` }), { maxItems: MAX_COMPLETION_ENTRIES }),
  validation: Type.Array(Type.String({ minLength: 1, description: `Maximum ${MAX_COMPLETION_ENTRY_BYTES} UTF-8 bytes` }), { maxItems: MAX_COMPLETION_ENTRIES }),
  remaining: Type.Array(Type.String({ minLength: 1, description: `Maximum ${MAX_COMPLETION_ENTRY_BYTES} UTF-8 bytes` }), { maxItems: MAX_COMPLETION_ENTRIES }),
}, { additionalProperties: false });

export const SendEmailSchema = Type.Object({
  to: Type.String({ description: "Recipient `<name>.<task-slug>@<registered-model>.com` or a main address" }),
  subject: Type.Optional(Type.String({ description: "Subject for new mail; legacy exact reply subjects remain readable" })),
  reply_to: Type.Optional(Type.String({ description: "Preferred reply correlation ID; the broker generates the canonical subject" })),
  message: Type.String({ description: "Self-contained request, notification, or response" }),
  priority: PrioritySchema,
  requires_response: Type.Optional(Type.Boolean({ description: "Explicitly request a response; worker-to-main mail otherwise defaults to a notification" })),
  completion: Type.Optional(ReplyCompletionSchema),
  effort: Type.Optional(EffortSchema),
  lifecycle: Type.Optional(LifecycleOverrideSchema),
}, { additionalProperties: false });

export const InspectAgentSchema = Type.Object({
  address: Type.String({ description: "Subagent address to inspect or preview" }),
  effort: Type.Optional(EffortSchema),
}, { additionalProperties: false });

export const WaitForRepliesSchema = Type.Object({
  request_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_REPLY_WAIT_SECONDS, default: 120 })),
  collect: Type.Optional(Type.Boolean({ default: true })),
}, { additionalProperties: false });

export const CancelRequestSchema = Type.Object({
  request_id: Type.String({ minLength: 1, description: "Exact request/correlation ID returned by send_email" }),
  reason: Type.String({ minLength: 8, description: "Why this obligation is being intentionally abandoned (maximum 1024 UTF-8 bytes)" }),
}, { additionalProperties: false });

export const ManageAgentSchema = Type.Object({
  address: Type.String({ description: "Exact existing subagent address" }),
  action: PiAi.StringEnum(["stop", "restart", "archive", "clear_failure"] as const),
}, { additionalProperties: false });
