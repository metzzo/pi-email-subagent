import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AddressError, makeMainAddress, ModelCatalog, parseSubagentAddress } from "../../src/address.ts";
import { fakeModel } from "../helpers/fakes.ts";

describe("email address routing", () => {
  it("parses a dotted OpenAI model ID without truncating it", () => {
    const catalog = new ModelCatalog([fakeModel("gpt-5.4")]);
    const parsed = parseSubagentAddress("Reviewer.Audit-Auth@GPT-5.4.COM", catalog);
    assert.equal(parsed.address, "reviewer.audit-auth@gpt-5.4.com");
    assert.equal(parsed.name, "reviewer");
    assert.equal(parsed.taskSlug, "audit-auth");
    assert.equal(parsed.modelId, "gpt-5.4");
  });

  it("supports registered Kimi model domains", () => {
    const catalog = new ModelCatalog([fakeModel("kimi-for-coding", "kimi-coding")]);
    assert.equal(
      parseSubagentAddress("scout.map-auth@kimi-for-coding.com", catalog).model.provider,
      "kimi-coding",
    );
  });

  it("rejects malformed local parts and unknown models", () => {
    const catalog = new ModelCatalog([fakeModel()]);
    for (const value of ["reviewer@gpt-5.4.com", "reviewer.a.b@gpt-5.4.com", "main@gpt-5.4.com"]) {
      assert.throws(() => parseSubagentAddress(value, catalog), AddressError);
    }
    assert.throws(() => parseSubagentAddress("scout.task@missing.com", catalog), /not routable/);
  });

  it("omits ambiguous model IDs from routable addresses", () => {
    const catalog = new ModelCatalog([fakeModel("shared", "openai-codex"), fakeModel("shared", "kimi-coding")]);
    assert.deepEqual(catalog.routableModelIds, []);
    assert.throws(() => parseSubagentAddress("scout.task@shared.com", catalog), /ambiguous/);
  });

  it("creates the required main address", () => {
    assert.equal(makeMainAddress("GPT-5.4"), "main@gpt-5.4.com");
  });
});
