const REPLY_PATTERN = /^Re:\s*\[(mail_[a-z0-9_-]+)\]\s+(.+)$/i;

export interface ParsedReplySubject {
  emailId: string;
  originalSubject: string;
}

export function parseReplySubject(subject: string): ParsedReplySubject | undefined {
  const match = REPLY_PATTERN.exec(subject.trim());
  if (!match) return undefined;
  return { emailId: match[1]!, originalSubject: match[2]!.trim() };
}

export function looksLikeReply(subject: string): boolean {
  return /^\s*re\s*:/i.test(subject);
}

export function makeReplySubject(emailId: string, originalSubject: string): string {
  return `Re: [${emailId}] ${originalSubject}`;
}
