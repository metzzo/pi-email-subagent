import { safeErrorSummary } from "./safe-summary.ts";

export type EmailErrorCode =
  | "EMAIL_NOT_ACCEPTED"
  | "EMAIL_DELIVERY_FAILED"
  | "REPLY_INVALID"
  | "INVALID_INPUT";

export interface EmailErrorFields {
  email_id?: string;
  reply_subject?: string;
  cause_code?: EmailErrorCode;
}

function visibleMessage(code: EmailErrorCode, message: string, fields: Readonly<EmailErrorFields>): string {
  const repair = Object.entries(fields)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}=${JSON.stringify(safeErrorSummary(value))}`);
  return `[${code}] ${message}${repair.length > 0 ? `\nRepair fields: ${repair.join("; ")}` : ""}`;
}

export class EmailProtocolError extends Error {
  readonly code: EmailErrorCode;
  readonly fields: Readonly<EmailErrorFields>;

  constructor(code: EmailErrorCode, message: string, fields: EmailErrorFields = {}) {
    const frozenFields = Object.freeze({ ...fields });
    super(visibleMessage(code, message, frozenFields));
    this.name = "EmailProtocolError";
    this.code = code;
    this.fields = frozenFields;
  }
}

export function emailErrorDetails(error: unknown): { code?: EmailErrorCode; message: string; fields: Readonly<EmailErrorFields> } {
  if (error instanceof EmailProtocolError) {
    return { code: error.code, message: safeErrorSummary(error), fields: error.fields };
  }
  return { message: safeErrorSummary(error), fields: Object.freeze({}) };
}
