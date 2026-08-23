import type { Model } from "@earendil-works/pi-ai";
import type { ModelBinding, ParsedAddress } from "./types.ts";

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MODEL_DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_DIAGNOSTIC_CANDIDATES = 8;
const MAX_DIAGNOSTIC_IDENTIFIER_CHARS = 100;

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
}

function boundedIdentifier(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_IDENTIFIER_CHARS
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_IDENTIFIER_CHARS)}…`;
}

function renderBinding(binding: ModelBinding): string {
  return `${boundedIdentifier(binding.provider)}/${boundedIdentifier(binding.modelId)}`;
}

function renderCandidates(models: readonly Model<any>[]): string {
  const shown = models
    .slice(0, MAX_DIAGNOSTIC_CANDIDATES)
    .map((model) => renderBinding({ provider: model.provider, modelId: model.id }));
  const omitted = models.length - shown.length;
  return `${shown.join(", ") || "none"}${omitted > 0 ? `, +${omitted} omitted` : ""}`;
}

export class ModelCatalog {
  private readonly byId = new Map<string, Model<any>[]>();

  constructor(models: readonly Model<any>[]) {
    for (const model of models) {
      const key = model.id.toLowerCase();
      const entries = this.byId.get(key) ?? [];
      entries.push(model);
      this.byId.set(key, entries);
    }
  }

  routableModelIds(preferredProvider?: string): string[] {
    const result: string[] = [];
    for (const [modelId] of this.byId) {
      try {
        result.push(this.resolveNew(modelId, preferredProvider).id);
      } catch { /* ambiguous for this prospective provider */ }
    }
    return result.sort();
  }

  resolveNew(modelId: string, preferredProvider?: string): Model<any> {
    const matches = this.byId.get(modelId.toLowerCase()) ?? [];
    if (matches.length === 0) {
      const available = this.routableModelIds(preferredProvider).join(", ") || "none";
      throw new AddressError(`Model ID "${modelId}" is not routable. Available email models: ${available}. No email was accepted.`);
    }
    if (matches.length === 1) return matches[0]!;
    const preferred = preferredProvider
      ? matches.filter((model) => model.provider === preferredProvider)
      : [];
    if (preferred.length === 1) return preferred[0]!;
    throw new AddressError(
      `Model ID "${boundedIdentifier(modelId)}" has candidates ${renderCandidates(matches)}. Current main provider "${boundedIdentifier(preferredProvider ?? "none")}" does not identify exactly one candidate; no email was accepted.`,
    );
  }

  resolveBound(binding: ModelBinding): Model<any> {
    const matches = (this.byId.get(binding.modelId.toLowerCase()) ?? [])
      .filter((model) => model.provider === binding.provider);
    if (matches.length === 1) return matches[0]!;
    const alternatives = this.byId.get(binding.modelId.toLowerCase()) ?? [];
    if (matches.length === 0) {
      const alternativeText = alternatives.length > 0
        ? ` Same-ID catalog candidates are ${renderCandidates(alternatives)}.`
        : "";
      throw new AddressError(
        `Identity is bound to ${renderBinding(binding)}, which is absent from the current catalog.${alternativeText} The identity was not rebound. Restore the provider/model configuration and reload.`,
      );
    }
    throw new AddressError(
      `Identity is bound to ${renderBinding(binding)}, but the current catalog contains ${matches.length} exact candidates (${renderCandidates(matches)}). The binding is unavailable and was not selected by catalog order.`,
    );
  }

  resolveLegacyUnique(modelId: string): Model<any> {
    const matches = this.byId.get(modelId.toLowerCase()) ?? [];
    if (matches.length === 1) return matches[0]!;
    throw new AddressError(
      `Accepted legacy mail has no durable provider binding and model ID "${boundedIdentifier(modelId)}" has ${matches.length === 0 ? "no catalog candidate" : `candidates ${renderCandidates(matches)}`}. The original provider cannot be inferred; the identity remains unavailable and no substitution was made.`,
    );
  }
}

export interface SubagentAddressShape {
  address: string;
  name: string;
  taskSlug: string;
  modelId: string;
}

export function parseSubagentAddressShape(input: string): SubagentAddressShape {
  const address = input.trim().toLowerCase();
  if (Buffer.byteLength(address, "utf8") > 254) throw new AddressError("Email address is too long.");

  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@")) {
    throw new AddressError('Use exactly one "@" in `<name>.<task-slug>@<model>.com`.');
  }

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!domain.endsWith(".com")) throw new AddressError("Subagent addresses must end in `.com`.");
  if (local === "main") throw new AddressError("`main@<model>.com` is reserved for the main Pi thread.");

  const separator = local.indexOf(".");
  if (separator <= 0 || separator !== local.lastIndexOf(".")) {
    throw new AddressError("Subagent local parts must contain exactly one dot between name and task slug.");
  }
  const name = local.slice(0, separator);
  const taskSlug = local.slice(separator + 1);
  if (!SEGMENT.test(name)) throw new AddressError(`Invalid subagent name "${name}"; use lowercase kebab-case.`);
  if (!SEGMENT.test(taskSlug)) throw new AddressError(`Invalid task slug "${taskSlug}"; use lowercase kebab-case.`);

  const modelId = domain.slice(0, -4);
  if (!MODEL_DOMAIN.test(modelId)) throw new AddressError(`Invalid model domain "${modelId}".`);
  return { address, name, taskSlug, modelId };
}

function parsedFrom(shape: SubagentAddressShape, model: Model<any>): ParsedAddress {
  const canonical = `${shape.name}.${shape.taskSlug}@${model.id.toLowerCase()}.com`;
  return { address: canonical, name: shape.name, taskSlug: shape.taskSlug, modelId: model.id, model };
}

export function parseNewSubagentAddress(
  input: string,
  catalog: ModelCatalog,
  preferredProvider?: string,
): ParsedAddress {
  const shape = parseSubagentAddressShape(input);
  return parsedFrom(shape, catalog.resolveNew(shape.modelId, preferredProvider));
}

export function parseBoundSubagentAddress(
  input: string,
  catalog: ModelCatalog,
  binding: ModelBinding,
): ParsedAddress {
  const shape = parseSubagentAddressShape(input);
  if (shape.modelId.toLowerCase() !== binding.modelId.toLowerCase()) {
    throw new AddressError(
      `Identity address model ID "${shape.modelId}" disagrees with persisted binding ${renderBinding(binding)}; no substitution was made.`,
    );
  }
  return parsedFrom(shape, catalog.resolveBound(binding));
}

export function parseLegacySubagentAddress(input: string, catalog: ModelCatalog): ParsedAddress {
  const shape = parseSubagentAddressShape(input);
  return parsedFrom(shape, catalog.resolveLegacyUnique(shape.modelId));
}

export function makeMainAddress(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (!MODEL_DOMAIN.test(normalized)) {
    throw new AddressError(`Model "${modelId}" cannot be represented as a main email address.`);
  }
  return `main@${normalized}.com`;
}

export function isMainAddressShape(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith("main@") && normalized.endsWith(".com");
}
