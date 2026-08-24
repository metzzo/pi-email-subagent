export const SAFE_SUMMARY_MAX_BYTES = 384;
export const SAFE_SUMMARY_MAX_LINES = 4;
export const SAFE_SUMMARY_FALLBACK = "External provider/session error.";

function messageValue(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function redactCommonCredentials(value: string): string {
  let result = value;
  // URL userinfo. Keep the scheme/host path useful without retaining either
  // user or password, which can both carry credential material.
  result = result.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/giu,
    "$1[redacted]@",
  );
  // Common authorization and credential-bearing headers/assignments.
  result = result.replace(
    /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/giu,
    "$1: [redacted]",
  );
  result = result.replace(/\bbearer\s+[a-z0-9._~+/=-]+/giu, "Bearer [redacted]");
  // Signed URLs and common credential query parameters.
  result = result.replace(
    /([?&](?:x-amz-(?:signature|credential|security-token)|signature|sig|access[_-]?token|refresh[_-]?token|api[_-]?key|key|token)=)[^&#\s]+/giu,
    "$1[redacted]",
  );
  // JSON/log key-value forms outside HTTP header syntax.
  result = result.replace(
    /(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|credential)["']?\s*[:=]\s*)(["']?)[^"'\s,;}]+\2/giu,
    "$1[redacted]",
  );
  // A bounded set of widely used standalone token prefixes. This is risk
  // reduction only; it intentionally does not claim universal detection.
  result = result.replace(
    /\b(?:sk|rk|ghp|github_pat|xox[baprs])-[a-z0-9_-]{8,}\b/giu,
    "[redacted]",
  );
  return result;
}

function wellFormed(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        output += value[index]! + value[index + 1]!;
        index += 1;
      } else output += "\uFFFD";
    } else if (first >= 0xdc00 && first <= 0xdfff) output += "\uFFFD";
    else output += value[index]!;
  }
  return output;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const room = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
  return `${utf8Prefix(value, room)}${ellipsis}`;
}

/**
 * Summarize provider/session/lifecycle errors before they enter registry, UI,
 * main-message, or work-ledger surfaces. Native AgentSession conversation
 * detail remains untouched. Redaction is bounded risk reduction, not a
 * universal secret detector.
 */
export function safeErrorSummary(value: unknown): string {
  const raw = messageValue(value);
  if (!raw) return SAFE_SUMMARY_FALLBACK;
  let clean = wellFormed(raw).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // Remove complete terminal escape strings before stripping remaining C0/C1
  // bytes. This prevents OSC/CSI payload fragments from controlling displays.
  clean = clean
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, " ")
    .replace(/\x1b[P_X^][\s\S]*?\x1b\\/gu, " ")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
  const lines = clean.split("\n", SAFE_SUMMARY_MAX_LINES + 1)
    .slice(0, SAFE_SUMMARY_MAX_LINES)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  clean = lines.join(" · ");
  if (!clean) return SAFE_SUMMARY_FALLBACK;
  clean = redactCommonCredentials(clean)
    // Neutralize extension/mail framing without entity-encoding that would
    // grow under repeated sanitization.
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return SAFE_SUMMARY_FALLBACK;
  return truncateUtf8(clean, SAFE_SUMMARY_MAX_BYTES);
}
