/**
 * Recognise the text on each scan, so search can find more than a typed first line.
 *
 *   npm run ocr -- --diary=5                 what it would do, writes nothing
 *   npm run ocr -- --diary=5 --commit        recognise with Tesseract and save
 *   npm run ocr -- --diary=1 --export=<dir>  write the scans out to transcribe elsewhere
 *   npm run ocr -- --diary=1 --import=<file> save transcriptions made elsewhere
 *
 * Other flags:
 *   --force     redo pages that already have text (never ones corrected by hand)
 *   --lang=eng  Tesseract language, default eng
 *
 * Preview by default and --commit to act, the same shape as `npm run add`.
 *
 * Why two routes. Tesseract is local, free and private, and it is genuinely
 * good at clean print -- which is what a typeset volume is. It is close to
 * useless on cursive, and published benchmarks put the big cloud OCR services
 * at roughly 45-63% on cursive narrative too, so a handwritten volume needs a
 * vision model. --export/--import is that path without this script needing an
 * API key: it hands the pages over, something else reads them, and the
 * transcriptions come back the same way.
 *
 * READS THE PUBLISHED OBJECT, NEVER THE ORIGINAL. originals/ holds the scan as
 * it was before redaction, so recognising from there would produce text
 * containing exactly the words the censor bars exist to hide -- and then make
 * them searchable. storage_key is the published copy, with the bars burned in,
 * which is also the only thing /api/scan will ever sign.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DIARY_ID } from "../src/lib/pages.js";
import { firstLineOf } from "../src/lib/page-text.js";
import { BUCKET, getSupabase } from "../src/lib/supabase.js";

const argv = process.argv.slice(2);
const commit = argv.includes("--commit");
const force = argv.includes("--force");

const flag = (name, fallback = null) => {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const diaryId = Number(flag("diary", DEFAULT_DIARY_ID));
const lang = flag("lang", "eng");
const exportDir = flag("export");
const importFile = flag("import");

if (!Number.isInteger(diaryId) || diaryId < 1) {
  fail(`--diary must be a positive integer, got ${flag("diary")}`);
}

const db = getSupabase();

/**
 * Every scan in the diary, with the text it already has.
 *
 * Two queries rather than an embed: this is the one place that wants the
 * storage key, and keeping the shapes separate makes the skip rules below plain
 * to read.
 */
async function loadPages() {
  const { data: pages, error } = await db
    .from("pages")
    .select("page_id, page_count, storage_key, first_line")
    .eq("diary_id", diaryId)
    .order("page_id", { ascending: true });
  if (error) fail(`could not read pages: ${error.message}`);
  if (!pages?.length) fail(`diary ${diaryId} has no pages`);

  const { data: texts, error: textError } = await db
    .from("page_text")
    .select("storage_key, source, edited_at")
    .in("storage_key", pages.map((p) => p.storage_key));
  if (textError) fail(`could not read page text: ${textError.message}`);

  const existing = new Map((texts ?? []).map((t) => [t.storage_key, t]));
  return pages.map((page) => ({ ...page, existing: existing.get(page.storage_key) ?? null }));
}

/**
 * Should this page be recognised again?
 *
 * A hand-corrected page is never redone, with or without --force. That is the
 * promise that makes re-running safe: correcting a page in the admin index is
 * permanent, so there is no reason to think before re-running over a volume.
 */
function skipReason(page) {
  if (page.existing?.source === "manual") return "corrected by hand";
  if (page.existing && !force) return "already has text";
  return null;
}

/** The published JPEG for one scan. */
async function download(storageKey) {
  const { data, error } = await db.storage.from(BUCKET).download(storageKey);
  if (error || !data) throw new Error(`could not download ${storageKey}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Save recognised text, and fill in a missing first line from it.
 *
 * Never overwrites a first line that is already there: a typed one is a
 * person's summary of the page and outranks the top line of whatever the
 * engine read.
 */
async function save(page, text, source) {
  const { error } = await db.from("page_text").upsert(
    { storage_key: page.storage_key, text, source, edited_at: null },
    { onConflict: "storage_key" }
  );
  if (error) throw new Error(`saving text for page ${page.page_id}: ${error.message}`);

  if (page.first_line) return false;

  const line = firstLineOf(text);
  if (!line) return false;

  const { error: lineError } = await db
    .from("pages")
    .update({ first_line: line })
    .eq("diary_id", diaryId)
    .eq("page_id", page.page_id);
  if (lineError) throw new Error(`saving first line for page ${page.page_id}: ${lineError.message}`);
  return true;
}

/** Recognise with Tesseract, locally. */
async function runTesseract(pages) {
  const { createWorker } = await import("tesseract.js");

  const todo = pages.filter((page) => !skipReason(page));
  for (const page of pages) {
    const reason = skipReason(page);
    if (reason) console.log(`  page ${String(page.page_id).padStart(3)}  skipped (${reason})`);
  }
  if (todo.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  // One worker for the batch, not one per page: loading the language data is
  // the slow part and it is identical every time.
  //
  // cachePath keeps the ~15 MB language file out of the repository. The default
  // is the working directory, which drops eng.traineddata next to package.json
  // -- gitignored now, but better not written there at all. os.tmpdir() matches
  // where ingest-staging.js puts its scratch files.
  // Created first: tesseract.js writes the cache without creating the directory,
  // and the failure is silent -- it simply re-downloads 5 MB on every run.
  const cachePath = path.join(os.tmpdir(), "diary-ocr");
  await mkdir(cachePath, { recursive: true });

  const worker = await createWorker(lang, undefined, { cachePath });
  let saved = 0;
  let linesFilled = 0;
  let usable = 0;

  try {
    for (const page of todo) {
      const bytes = await download(page.storage_key);
      const { data } = await worker.recognize(bytes);
      const text = data.text.trim();

      const line = firstLineOf(text);
      console.log(
        `  page ${String(page.page_id).padStart(3)}  ${String(text.length).padStart(5)} chars` +
          `  conf ${String(Math.round(data.confidence)).padStart(3)}  ${line ?? "(nothing readable)"}`
      );

      // A page that recognised as nothing is not saved, so it must not be
      // counted in the preview either -- a preview that promises more than the
      // commit delivers is worse than no preview.
      if (text === "") continue;
      usable += 1;

      if (!commit) continue;
      if (await save(page, text, "tesseract")) linesFilled += 1;
      saved += 1;
    }
  } finally {
    await worker.terminate();
  }

  report(saved, linesFilled, usable);
}

/**
 * Write the scans out, for transcription by something that can read handwriting.
 *
 * The manifest is what --import reads back, so the transcriber only has to
 * produce text per page number and never has to know about storage keys.
 */
async function runExport(pages) {
  const todo = pages.filter((page) => !skipReason(page));
  if (todo.length === 0) {
    console.log("Nothing to export; every page has text already (--force to redo).");
    return;
  }

  await mkdir(exportDir, { recursive: true });
  const manifest = [];

  for (const page of todo) {
    const name = `page-${String(page.page_id).padStart(4, "0")}.jpg`;
    await writeFile(path.join(exportDir, name), await download(page.storage_key));
    manifest.push({ pageId: page.page_id, pageCount: page.page_count, file: name });
    console.log(`  wrote ${name}  (page ${page.page_id})`);
  }

  const manifestPath = path.join(exportDir, "pages.json");
  await writeFile(manifestPath, `${JSON.stringify({ diaryId, pages: manifest }, null, 2)}\n`);

  console.log(`\n${todo.length} scan(s) written to ${exportDir}`);
  console.log(`Transcribe them, then write a file shaped like:`);
  console.log(`  { "diaryId": ${diaryId}, "pages": [{ "pageId": 1, "text": "..." }] }`);
  console.log(`and run: npm run ocr -- --diary=${diaryId} --import=<file> --commit`);
}

/** Save transcriptions produced elsewhere. */
async function runImport(pages) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(importFile, "utf8"));
  } catch (error) {
    fail(`could not read ${importFile}: ${error.message}`);
  }

  if (Number(parsed.diaryId) !== diaryId) {
    // Pages are numbered from 1 in every volume, so importing the wrong file
    // would write one diary's transcriptions onto another's pages.
    fail(`that file is for diary ${parsed.diaryId}, not ${diaryId}`);
  }
  if (!Array.isArray(parsed.pages)) fail(`${importFile} has no "pages" array`);

  const byPageId = new Map(pages.map((page) => [page.page_id, page]));
  let saved = 0;
  let linesFilled = 0;

  for (const entry of parsed.pages) {
    const page = byPageId.get(Number(entry.pageId));
    if (!page) {
      console.log(`  page ${entry.pageId}  NOT IN THIS DIARY, skipped`);
      continue;
    }
    const reason = skipReason(page);
    if (reason) {
      console.log(`  page ${String(page.page_id).padStart(3)}  skipped (${reason})`);
      continue;
    }

    const text = String(entry.text ?? "").trim();
    if (text === "") {
      console.log(`  page ${String(page.page_id).padStart(3)}  empty, skipped`);
      continue;
    }

    console.log(
      `  page ${String(page.page_id).padStart(3)}  ${String(text.length).padStart(5)} chars` +
        `  ${firstLineOf(text)}`
    );
    if (!commit) continue;
    if (await save(page, text, "claude")) linesFilled += 1;
    saved += 1;
  }

  report(saved, linesFilled, parsed.pages.length);
}

function report(saved, linesFilled, considered) {
  if (!commit) {
    console.log(
      considered === 0
        ? "\nNothing recognised, so nothing to save."
        : `\n${considered} page(s) would be saved. Re-run with --commit.`
    );
    return;
  }
  console.log(
    `\nSaved text for ${saved} page(s)` +
      (linesFilled ? `, and filled in ${linesFilled} missing first line(s).` : ".")
  );
}

function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

const pages = await loadPages();
console.log(
  `Diary ${diaryId}: ${pages.length} scan(s)` +
    (commit ? "" : "  (preview -- nothing will be written)")
);

if (exportDir) await runExport(pages);
else if (importFile) await runImport(pages);
else await runTesseract(pages);
