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
  // Only `Re: [...`-shaped subjects are treated as malformed reply attempts;
  // plain subjects that happen to start with "Re:" remain valid new mail.
  return /^\s*re\s*:\s*\[/i.test(subject);
}

export function makeReplySubject(emailId: string, originalSubject: string): string {
  return `Re: [${emailId}] ${originalSubject}`;
}
