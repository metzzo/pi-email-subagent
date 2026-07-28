import type { Model } from "@earendil-works/pi-ai";
import type { ParsedAddress } from "./types.ts";

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MODEL_DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
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

  get routableModelIds(): string[] {
    return [...this.byId.entries()]
      .filter(([, models]) => models.length === 1)
      .map(([, models]) => models[0]!.id)
      .sort();
  }

  resolve(modelId: string): Model<any> {
    const matches = this.byId.get(modelId.toLowerCase()) ?? [];
    if (matches.length === 0) {
      const available = this.routableModelIds.join(", ") || "none";
      throw new AddressError(`Model \"${modelId}\" is not routable. Available email models: ${available}.`);
    }
    if (matches.length > 1) {
      const providers = matches.map((model) => model.provider).join(", ");
      throw new AddressError(
        `Model ID \"${modelId}\" is ambiguous across providers (${providers}) and cannot be encoded in an email address.`,
      );
    }
    return matches[0]!;
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
  if (!SEGMENT.test(name)) throw new AddressError(`Invalid subagent name \"${name}\"; use lowercase kebab-case.`);
  if (!SEGMENT.test(taskSlug)) throw new AddressError(`Invalid task slug \"${taskSlug}\"; use lowercase kebab-case.`);

  const modelId = domain.slice(0, -4);
  if (!MODEL_DOMAIN.test(modelId)) throw new AddressError(`Invalid model domain \"${modelId}\".`);
  return { address, name, taskSlug, modelId };
}

export function parseSubagentAddress(input: string, catalog: ModelCatalog): ParsedAddress {
  const shape = parseSubagentAddressShape(input);
  const model = catalog.resolve(shape.modelId);
  const canonical = `${shape.name}.${shape.taskSlug}@${model.id.toLowerCase()}.com`;
  return { address: canonical, name: shape.name, taskSlug: shape.taskSlug, modelId: model.id, model };
}

export function makeMainAddress(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (!MODEL_DOMAIN.test(normalized)) {
    throw new AddressError(`Model \"${modelId}\" cannot be represented as a main email address.`);
  }
  return `main@${normalized}.com`;
}

export function isMainAddressShape(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith("main@") && normalized.endsWith(".com");
}
