import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

// Reserve enough room for tool-specific headings and the truncation notice so
// assembled results remain below Pi's hard context-safety recommendations.
export const TOOL_RESULT_PAYLOAD_BYTES = PiCodingAgent.DEFAULT_MAX_BYTES - 1_024;
export const TOOL_RESULT_PAYLOAD_LINES = PiCodingAgent.DEFAULT_MAX_LINES - 32;
// Mail batching needs another reserve for fetch/join headings and summaries.
export const MAIL_TOOL_BATCH_BYTES = TOOL_RESULT_PAYLOAD_BYTES - 1_024;
export const MAIL_TOOL_BATCH_LINES = TOOL_RESULT_PAYLOAD_LINES - 16;

export function boundedToolText(text: string): string {
  const result = PiCodingAgent.truncateHead(text, {
    maxBytes: TOOL_RESULT_PAYLOAD_BYTES,
    maxLines: TOOL_RESULT_PAYLOAD_LINES,
  });
  if (!result.truncated) return text;
  const reason = result.truncatedBy === "lines"
    ? `${result.outputLines} of ${result.totalLines} lines`
    : `${PiCodingAgent.formatSize(result.outputBytes)} of ${PiCodingAgent.formatSize(result.totalBytes)}`;
  const prefix = result.content ? `${result.content}\n\n` : "";
  return `${prefix}[Output truncated: showing ${reason}. Use the tool's paging or smaller-group guidance to retrieve omitted content.]`;
}

export function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text: boundedToolText(text) }],
    details,
  };
}
