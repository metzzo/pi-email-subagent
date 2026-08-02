import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_PRODUCTION_LICENSES,
  productionLicenseInventory,
  rejectedProductionLicenses,
} from "../../scripts/check-dependency-licenses.ts";

describe("production dependency license policy", () => {
  it("reports only shipped production packages in deterministic order", () => {
    const inventory = productionLicenseInventory({
      lockfileVersion: 3,
      packages: {
        "": { version: "0.1.0", license: "MIT" },
        "node_modules/z": { version: "2.0.0", license: "ISC" },
        "node_modules/a": { version: "1.0.0", license: "MIT" },
        "node_modules/dev-only": { version: "1.0.0", license: "MIT", dev: true },
        "node_modules/host-peer": { version: "1.0.0", license: "MIT", peer: true },
        "node_modules/link": { version: "1.0.0", license: "MIT", link: true },
      },
    });

    assert.deepEqual(inventory, [
      { name: "a", version: "1.0.0", license: "MIT", path: "node_modules/a" },
      { name: "z", version: "2.0.0", license: "ISC", path: "node_modules/z" },
    ]);
    assert.deepEqual(rejectedProductionLicenses(inventory), []);
  });

  it("fails closed for malformed locks, missing licenses, and unreviewed SPDX expressions", () => {
    assert.throws(() => productionLicenseInventory({ lockfileVersion: 2, packages: {} }), /lockfileVersion 3/);
    assert.throws(() => productionLicenseInventory({ lockfileVersion: 3, packages: { "node_modules/x": { version: "1.0.0" } } }), /no SPDX license/);
    const inventory = productionLicenseInventory({
      lockfileVersion: 3,
      packages: { "node_modules/x": { version: "1.0.0", license: "GPL-3.0-only" } },
    });
    assert.deepEqual(rejectedProductionLicenses(inventory), [
      { name: "x", version: "1.0.0", license: "GPL-3.0-only", path: "node_modules/x" },
    ]);
    assert.equal(ALLOWED_PRODUCTION_LICENSES.has("GPL-3.0-only"), false);
    assert.equal(ALLOWED_PRODUCTION_LICENSES.has("UNKNOWN"), false);
  });
});
