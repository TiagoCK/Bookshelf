import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_UPLOAD_BYTES } from "../src/lib/ingest.js";
import {
  PLATFORM_MAX_UPLOAD_BYTES,
  UPLOADS_OFF,
  mb,
  uploadLimits,
} from "../src/lib/uploads.js";

/** Vercel's documented maximum request body for a function. */
const DOCUMENTED_PLATFORM_CAP = 4.5 * 1024 * 1024;

describe("uploads: the ceiling follows the host", () => {
  it("gives a writable tree the full limit", () => {
    const limits = uploadLimits({ setting: undefined, treeWritable: true });
    assert.equal(limits.enabled, true);
    assert.equal(limits.maxBytes, MAX_UPLOAD_BYTES);
    assert.equal(limits.ephemeral, false);
  });

  it("gives a read-only tree the platform limit", () => {
    const limits = uploadLimits({ setting: undefined, treeWritable: false });
    assert.equal(limits.enabled, true);
    assert.equal(limits.maxBytes, PLATFORM_MAX_UPLOAD_BYTES);
    assert.equal(limits.ephemeral, true);
  });

  it("leaves headroom under what the platform actually rejects at", () => {
    // The point of advertising less than the documented cap: the refusal comes
    // from us, with somewhere to go, instead of as an opaque 413 after the
    // whole file has been sent.
    assert.ok(
      PLATFORM_MAX_UPLOAD_BYTES < DOCUMENTED_PLATFORM_CAP,
      `${mb(PLATFORM_MAX_UPLOAD_BYTES)} MB must stay under ${mb(DOCUMENTED_PLATFORM_CAP)} MB`
    );
    assert.ok(PLATFORM_MAX_UPLOAD_BYTES < MAX_UPLOAD_BYTES);
  });
});

describe("uploads: the off switch", () => {
  it("refuses on a writable tree", () => {
    const limits = uploadLimits({ setting: "off", treeWritable: true });
    assert.equal(limits.enabled, false);
    assert.equal(limits.reason, UPLOADS_OFF);
  });

  it("refuses on a read-only tree", () => {
    assert.equal(uploadLimits({ setting: "off", treeWritable: false }).enabled, false);
  });

  it("is the only value that refuses", () => {
    // There is deliberately no "on". The smaller ceiling is a property of the
    // host, and a flag claiming to lift it would only move the failure to the
    // platform. So anything that is not exactly "off" allows, and the ceiling
    // still comes from the filesystem.
    for (const setting of ["", "on", "true", "1", "OFF", "no", undefined]) {
      const limits = uploadLimits({ setting, treeWritable: false });
      assert.equal(limits.enabled, true, `${JSON.stringify(setting)} should allow`);
      assert.equal(limits.maxBytes, PLATFORM_MAX_UPLOAD_BYTES);
    }
  });

  it("says where to go instead", () => {
    assert.match(UPLOADS_OFF, /machine that holds your originals/);
  });
});

describe("uploads: mb", () => {
  it("formats one decimal place, so every message agrees", () => {
    assert.equal(mb(PLATFORM_MAX_UPLOAD_BYTES), "4.0");
    assert.equal(mb(MAX_UPLOAD_BYTES), "100.0");
    assert.equal(mb(12458568), "11.9");
  });
});
