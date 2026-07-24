import { randomBytes } from "node:crypto";

let lastMs = 0;
let sequence = 0;

export function createMailId(now = Date.now()): string {
  if (now === lastMs) sequence += 1;
  else {
    lastMs = now;
    sequence = 0;
  }
  const time = now.toString(36).padStart(10, "0");
  const seq = sequence.toString(36).padStart(3, "0");
  const random = randomBytes(5).toString("hex");
  return `mail_${time}_${seq}_${random}`;
}
