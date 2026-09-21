import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { MechanisticBinding, MechanisticCaller, MechanisticProgram } from "./types.ts";

export const MECHANISTIC_MODEL_ID = "mechanistic";
export const MECHANISTIC_DOMAIN = "mechanistic.com";
export const MAX_MECHANISTIC_PROGRAMS = 32;
export const MAX_MECHANISTIC_PATH_BYTES = 4096;
export const MAX_PROGRAM_DESCRIPTION_BYTES = 256;
export const MAX_PROGRAM_EXAMPLES = 3;
export const MAX_PROGRAM_EXAMPLE_BYTES = 1024;
export const PROTOCOL_BYTES = 64 * 1024;
export const SUMMARY_BYTES = 4 * 1024;
export const ARTIFACT_BYTES = 2 * 1024;
export const MAX_ARTIFACTS = 32;
export const MAX_COMMANDS = 16;
export const PROGRESS_INTERVAL_MS = 250;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function assertUnreservedModel(modelId: string): void {
  if (modelId.trim().toLowerCase() === MECHANISTIC_MODEL_ID) {
    throw new Error("mechanistic.com is reserved; model/catalog/main/persisted bindings cannot claim mechanistic.");
  }
}

export function isMechanisticAddress(address: string): boolean {
  return address.trim().toLowerCase().endsWith(`@${MECHANISTIC_DOMAIN}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mechanisticPrograms entries must be objects.");
  return value as Record<string, unknown>;
}

function pathText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_MECHANISTIC_PATH_BYTES
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`Mechanistic paths must be non-empty safe strings of at most ${MAX_MECHANISTIC_PATH_BYTES} bytes.`);
  }
  return value;
}

export function parseMechanisticBinding(value: unknown): MechanisticBinding {
  const raw = object(value);
  if (typeof raw.key !== "string" || !NAME.test(raw.key)) throw new Error("Invalid mechanistic registration key.");
  const python = pathText(raw.python); const script = pathText(raw.script); const cwd = pathText(raw.cwd);
  if (![python, script, cwd].every(isAbsolute)) throw new Error("Durable mechanistic binding paths must be absolute.");
  return { key: raw.key, python, script, cwd };
}

export function parseMechanisticCallers(value: unknown): MechanisticCaller[] {
  if (value === undefined) return ["main"];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3
    || new Set(value).size !== value.length || value.some((item) => !["main", "llm", "mechanistic"].includes(item))) {
    throw new Error("allowedCallers must contain 1–3 unique caller kinds: main, llm, mechanistic.");
  }
  return [...value] as MechanisticCaller[];
}

/** Side-effect-free: never execute a program to validate registration or admission. */
export function preflightMechanisticBinding(binding: MechanisticBinding): void {
  accessSync(binding.python, constants.X_OK);
  if (!statSync(binding.python).isFile()) throw new Error("Mechanistic Python executable must be a file.");
  accessSync(binding.script, constants.R_OK);
  if (!statSync(binding.script).isFile()) throw new Error("Mechanistic script must be a readable file.");
  accessSync(binding.cwd, constants.R_OK | constants.X_OK);
  if (!statSync(binding.cwd).isDirectory()) throw new Error("Mechanistic cwd must be a directory.");
}

export function sameMechanisticBinding(left: MechanisticBinding, right: MechanisticBinding): boolean {
  return left.key === right.key && left.python === right.python && left.script === right.script && left.cwd === right.cwd;
}

export function mergeMechanisticPrograms(
  base: Record<string, MechanisticProgram>, value: unknown, baseDir: string,
): Record<string, MechanisticProgram> {
  if (value === undefined) return base;
  const entries = Object.entries(object(value));
  if (entries.length + Object.keys(base).length > MAX_MECHANISTIC_PROGRAMS) {
    throw new Error(`mechanisticPrograms must contain at most ${MAX_MECHANISTIC_PROGRAMS} source registrations across trusted layers.`);
  }
  const result = { ...base };
  for (const [source, value] of entries) {
    const key = source.trim().toLowerCase();
    if (!NAME.test(key)) throw new Error("Invalid mechanistic program name.");
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate canonical mechanistic program ${key}.`);
    const raw = object(value);
    if (Object.keys(raw).some((field) => !["python", "script", "cwd", "allowedCallers", "description", "inputExamples"].includes(field))) {
      throw new Error(`Unknown registration field for mechanistic program ${key}.`);
    }
    const executable = pathText(raw.python);
    let python: string | undefined;
    if (isAbsolute(executable) || /[\\/]/u.test(executable)) python = resolve(baseDir, executable);
    else {
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        const candidate = resolve(baseDir, directory, executable);
        try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) { python = candidate; break; } } catch { /* next PATH entry */ }
      }
    }
    if (!python) throw new Error(`Python executable for ${key} was not found on PATH.`);
    // Keep the selected absolute invocation path: dereferencing a venv's final
    // interpreter symlink changes sys.prefix and its import environment.
    const binding = parseMechanisticBinding({ key, python, script: resolve(baseDir, pathText(raw.script)), cwd: resolve(baseDir, pathText(raw.cwd ?? ".")) });
    preflightMechanisticBinding(binding);
    const description = raw.description;
    if (description !== undefined && (typeof description !== "string" || !description.trim() || Buffer.byteLength(description) > MAX_PROGRAM_DESCRIPTION_BYTES || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(description))) {
      throw new Error(`Program description must be safe single-line text of at most ${MAX_PROGRAM_DESCRIPTION_BYTES} UTF-8 bytes.`);
    }
    const inputExamples = raw.inputExamples;
    if (inputExamples !== undefined) {
      if (!Array.isArray(inputExamples) || inputExamples.length > MAX_PROGRAM_EXAMPLES) throw new Error(`At most ${MAX_PROGRAM_EXAMPLES} input examples are allowed.`);
      for (const example of inputExamples) {
        if (typeof example !== "string" || Buffer.byteLength(example) > MAX_PROGRAM_EXAMPLE_BYTES) throw new Error(`Each input example must be a JSON object string of at most ${MAX_PROGRAM_EXAMPLE_BYTES} UTF-8 bytes.`);
        try { object(JSON.parse(example)); } catch { throw new Error("Each input example must encode a JSON object."); }
      }
    }
    result[key] = { ...binding, allowedCallers: parseMechanisticCallers(raw.allowedCallers), ...(description === undefined ? {} : { description }), ...(inputExamples === undefined ? {} : { inputExamples: [...inputExamples] as string[] }) };
  }
  return result;
}
