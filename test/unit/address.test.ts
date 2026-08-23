import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AddressError,
  makeMainAddress,
  ModelCatalog,
  parseBoundSubagentAddress,
  parseNewSubagentAddress,
  parseSubagentAddressShape,
} from "../../src/address.ts";
import { fakeModel } from "../helpers/fakes.ts";

describe("email address routing", () => {
  it("parses a dotted OpenAI model ID without truncating it", () => {
    const catalog = new ModelCatalog([fakeModel("gpt-5.4")]);
    const parsed = parseNewSubagentAddress("Reviewer.Audit-Auth@GPT-5.4.COM", catalog);
    assert.equal(parsed.address, "reviewer.audit-auth@gpt-5.4.com");
    assert.equal(parsed.name, "reviewer");
    assert.equal(parsed.taskSlug, "audit-auth");
    assert.equal(parsed.modelId, "gpt-5.4");
  });

  it("parses and canonicalizes address shape without requiring a routable model", () => {
    assert.deepEqual(parseSubagentAddressShape(" Worker.Task@Removed.Model.com "), {
      address: "worker.task@removed.model.com",
      name: "worker",
      taskSlug: "task",
      modelId: "removed.model",
    });
  });

  it("supports registered Kimi model domains", () => {
    const catalog = new ModelCatalog([fakeModel("kimi-for-coding", "kimi-coding")]);
    assert.equal(
      parseNewSubagentAddress("scout.map-auth@kimi-for-coding.com", catalog).model.provider,
      "kimi-coding",
    );
  });

  it("rejects malformed local parts and unknown models", () => {
    const catalog = new ModelCatalog([fakeModel()]);
    for (const value of ["reviewer@gpt-5.4.com", "reviewer.a.b@gpt-5.4.com", "main@gpt-5.4.com"]) {
      assert.throws(() => parseNewSubagentAddress(value, catalog), AddressError);
    }
    assert.throws(() => parseNewSubagentAddress("scout.task@missing.com", catalog), /not routable/);
  });

  it("omits ambiguous model IDs from routable addresses without a matching provider preference", () => {
    const models = [fakeModel("shared", "openai-codex"), fakeModel("shared", "github-copilot")];
    const catalog = new ModelCatalog(models);
    assert.deepEqual(catalog.routableModelIds(), []);
    assert.throws(() => parseNewSubagentAddress("scout.task@shared.com", catalog), /current main provider/i);

    assert.deepEqual(catalog.routableModelIds("kimi-coding"), []);
    assert.throws(() => parseNewSubagentAddress("scout.task@shared.com", catalog, "kimi-coding"), /current main provider/i);
  });

  it("routes an ambiguous model ID through the current provider preference", () => {
    const catalog = new ModelCatalog(
      [fakeModel("gpt-5.6-sol", "github-copilot"), fakeModel("gpt-5.6-sol", "openai-codex")],
    );
    assert.deepEqual(catalog.routableModelIds("openai-codex"), ["gpt-5.6-sol"]);
    assert.equal(parseNewSubagentAddress("worker.task@gpt-5.6-sol.com", catalog, "openai-codex").model.provider, "openai-codex");
  });

  it("distinguishes prospective selection from exact durable binding", () => {
    const models = [fakeModel("shared", "provider-a"), fakeModel("shared", "provider-b")];
    const catalog = new ModelCatalog(models);

    assert.equal(catalog.resolveNew("shared", "provider-a").provider, "provider-a");
    assert.equal(catalog.resolveNew("shared", "provider-b").provider, "provider-b");
    assert.throws(() => catalog.resolveNew("shared"), /current main provider.*none/i);
    assert.throws(() => catalog.resolveNew("shared", "provider-c"), /current main provider.*provider-c/i);
    assert.equal(catalog.resolveBound({ provider: "provider-a", modelId: "SHARED" }).provider, "provider-a");
    assert.equal(
      parseBoundSubagentAddress("worker.bound@shared.com", catalog, { provider: "provider-a", modelId: "shared" }).model.provider,
      "provider-a",
    );
    assert.equal(parseNewSubagentAddress("worker.new@shared.com", catalog, "provider-b").model.provider, "provider-b");
    assert.throws(
      () => parseBoundSubagentAddress("worker.bound@other.com", catalog, { provider: "provider-a", modelId: "shared" }),
      /address model ID.*disagrees with persisted binding.*no substitution/i,
    );
  });

  it("fails closed for duplicate entries under one preferred provider and for cross-provider bound fallback", () => {
    const catalog = new ModelCatalog([
      fakeModel("shared", "provider-a"),
      fakeModel("shared", "provider-a"),
      fakeModel("shared", "provider-b"),
    ]);
    assert.throws(() => catalog.resolveNew("shared", "provider-a"), /does not identify exactly one candidate/i);
    assert.throws(
      () => catalog.resolveBound({ provider: "provider-c", modelId: "shared" }),
      /bound to provider-c\/shared.*not rebound/i,
    );
  });

  it("computes prospective routability from the provider passed at call time", () => {
    const catalog = new ModelCatalog([
      fakeModel("alpha-only", "provider-a"),
      fakeModel("shared", "provider-a"),
      fakeModel("shared", "provider-b"),
      fakeModel("same-provider-duplicate", "provider-a"),
      fakeModel("same-provider-duplicate", "provider-a"),
    ]);
    assert.deepEqual(catalog.routableModelIds("provider-a"), ["alpha-only", "shared"]);
    assert.deepEqual(catalog.routableModelIds("provider-b"), ["alpha-only", "shared"]);
    assert.deepEqual(catalog.routableModelIds("provider-c"), ["alpha-only"]);
  });

  it("resolves legacy unbound identities only when there is one global candidate", () => {
    const unique = new ModelCatalog([fakeModel("shared", "provider-a")]);
    assert.equal(unique.resolveLegacyUnique("shared").provider, "provider-a");
    const duplicate = new ModelCatalog([fakeModel("shared", "provider-a"), fakeModel("shared", "provider-b")]);
    assert.throws(() => duplicate.resolveLegacyUnique("shared"), /original provider cannot be inferred/i);
  });

  it("creates the required main address", () => {
    assert.equal(makeMainAddress("GPT-5.4"), "main@gpt-5.4.com");
  });
});
