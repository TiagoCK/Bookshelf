import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_FIRST_LINE, firstLineOf } from "../src/lib/page-text.js";

describe("page text: firstLineOf", () => {
  it("takes the first line", () => {
    assert.equal(firstLineOf("Melee Combat Tasks\nMelee Attack\nCharge"), "Melee Combat Tasks");
  });

  it("skips blank and whitespace-only lines", () => {
    assert.equal(firstLineOf("\n\n   \n\t\nThursday, the rain finally\n"), "Thursday, the rain finally");
  });

  it("skips lines with nothing readable in them", () => {
    // What OCR does with a page border, a rule, or specks along the gutter.
    // Taking the literal first line would make this the page's summary.
    assert.equal(firstLineOf("|||\n---\n. . .\n~~~\nPreparation Tasks"), "Preparation Tasks");
  });

  it("collapses the runs of spaces an engine leaves where columns were", () => {
    assert.equal(firstLineOf("Core   Rules      23\nnext"), "Core Rules 23");
  });

  it("keeps a line that is only a number, which is a real page heading", () => {
    assert.equal(firstLineOf("23\nMelee"), "23");
  });

  it("handles accented and non-Latin text", () => {
    assert.equal(firstLineOf("Café Journal\nrest"), "Café Journal");
    assert.equal(firstLineOf("日記\nrest"), "日記");
  });

  it("returns null for nothing usable", () => {
    assert.equal(firstLineOf(""), null);
    assert.equal(firstLineOf("\n\n  \n"), null);
    assert.equal(firstLineOf("--- ||| ..."), null);
    assert.equal(firstLineOf(null), null);
    assert.equal(firstLineOf(undefined), null);
  });

  it("handles CRLF, which a PDF-derived text layer can carry", () => {
    assert.equal(firstLineOf("\r\nLeadership Tasks\r\nmore"), "Leadership Tasks");
  });
});

describe("page text: firstLineOf truncation", () => {
  it("leaves a line at the limit alone", () => {
    const exact = "a".repeat(MAX_FIRST_LINE);
    assert.equal(firstLineOf(exact), exact);
    assert.equal(firstLineOf(exact).length, MAX_FIRST_LINE);
  });

  it("cuts a long line at a word boundary", () => {
    const line = `${"word ".repeat(200)}end`;
    const result = firstLineOf(line);
    assert.ok(result.length <= MAX_FIRST_LINE + 1, `got ${result.length}`);
    assert.ok(result.endsWith("…"));
    // The point of cutting at a space: no half-word before the ellipsis.
    assert.ok(result.slice(0, -1).endsWith("word"), result.slice(-20));
  });

  it("hard-cuts a long line with no spaces rather than returning all of it", () => {
    // A scanning artefact, not prose. Better truncated than unbounded.
    const result = firstLineOf("x".repeat(MAX_FIRST_LINE * 2));
    assert.equal(result.length, MAX_FIRST_LINE + 1);
    assert.ok(result.endsWith("…"));
  });
});
