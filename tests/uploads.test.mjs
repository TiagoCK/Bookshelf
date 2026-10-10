import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UPLOADS_OFF,
  UPLOADS_READ_ONLY,
  uploadVerdict,
} from "../src/lib/uploads.js";

describe("uploads: the explicit setting wins", () => {
  it("off refuses even on a writable tree", () => {
    const verdict = uploadVerdict({ setting: "off", treeWritable: true });
    assert.equal(verdict.enabled, false);
    assert.equal(verdict.reason, UPLOADS_OFF);
  });

  it("on allows even on a read-only tree", () => {
    // The escape hatch. Someone who sets this means it, and the routes have
    // nothing else to go on -- so it has to beat the inference, not lose to it.
    assert.deepEqual(uploadVerdict({ setting: "on", treeWritable: false }), {
      enabled: true,
    });
  });
});

describe("uploads: inferred from the filesystem", () => {
  it("allows a writable tree", () => {
    assert.deepEqual(uploadVerdict({ setting: undefined, treeWritable: true }), {
      enabled: true,
    });
  });

  it("refuses a read-only tree, which is what a deployment looks like", () => {
    const verdict = uploadVerdict({ setting: undefined, treeWritable: false });
    assert.equal(verdict.enabled, false);
    assert.equal(verdict.reason, UPLOADS_READ_ONLY);
  });

  it("treats a value that is neither on nor off as unset", () => {
    // DIARY_UPLOADS="true" or "1" is someone guessing at the vocabulary. The
    // filesystem is a better answer than reading intent into a typo -- and the
    // dangerous direction would be to treat it as "on" and let a deployment
    // accept an upload it cannot finish.
    for (const setting of ["", "true", "1", "yes", "ON", "OFF"]) {
      assert.equal(
        uploadVerdict({ setting, treeWritable: false }).enabled,
        false,
        `${JSON.stringify(setting)} should not enable uploads on a read-only tree`
      );
    }
  });
});

describe("uploads: the reasons say where to go instead", () => {
  it("both name the machine holding the originals", () => {
    // The point of refusing rather than failing: an admin who reads this should
    // know what to do next, not just that it did not work.
    for (const reason of [UPLOADS_OFF, UPLOADS_READ_ONLY]) {
      assert.match(reason, /machine that holds your originals/);
    }
  });
});
