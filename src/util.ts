import { createHash } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function addressHash(address: string): string {
  return createHash("sha256").update(address).digest("hex").slice(0, 24);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
