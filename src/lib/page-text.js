/**
 * Recognised text for a scan: reading it, writing it, and deriving a first line.
 *
 * Search has always matched on first_line, which has to be typed, so of 49
 * scans exactly 2 could be found. This is the supply side of that problem --
 * the matching rule in src/lib/search.js is unchanged and still the only one.
 *
 * A separate module from pages.js on purpose. getPages() runs on every render
 * of the reader, and page text is the one piece of this data that is large and
 * that the reader never shows; keeping it in a module the reader has no reason
 * to import is what stops it drifting into that path later.
 */

import { contentIdFor } from "./pages.js";
import { outageOr } from "./outage.js";

/**
 * How much of a derived first line to keep.
 *
 * Matches the ceiling updateFirstLine() enforces, so a derived line and a typed
 * one cannot have different limits.
 */
export const MAX_FIRST_LINE = 500;

/** The engines, and the marker that a human has corrected one of them. */
export const TEXT_SOURCES = ["tesseract", "claude", "manual"];

/**
 * The first usable line of recognised text, or null.
 *
 * "Usable" does some work. OCR output routinely opens with a rule, a page
 * border read as pipes, or a run of specks -- lines with no letter or digit in
 * them. Taking the literal first line would make those the searchable summary
 * of the page, so lines without a single alphanumeric are skipped.
 *
 * Internal whitespace is collapsed because recognised text is full of runs of
 * spaces where the engine saw column gaps, and a first line is shown as prose.
 */
export function firstLineOf(text) {
  if (typeof text !== "string") return null;

  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    return truncate(cleaned);
  }
  return null;
}

/**
 * Cut at a word boundary rather than mid-word.
 *
 * Only when there is a space to cut at: a 500-character run with none is
 * something like a scanning artefact, and a hard cut is better than returning
 * the whole thing.
 */
function truncate(line) {
  if (line.length <= MAX_FIRST_LINE) return line;

  const cut = line.slice(0, MAX_FIRST_LINE);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > MAX_FIRST_LINE / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Every scan in one diary that has recognised text, keyed by contentId.
 *
 * contentId rather than the storage key, because that is the identifier the
 * rest of the app already uses to say "this scan" -- getPages() derives it the
 * same way, so a caller can line the two up without the storage key ever
 * leaving this module. That is the same reason contentIdFor() exists.
 */
export async function getPageText(diaryId) {
  if (!Number.isInteger(diaryId)) throw new Error("getPageText needs a diary id.");

  const { getSupabase } = await import("./supabase.js");

  // Filtered through the embedded pages row rather than by collecting storage
  // keys first: one round trip, and the diary filter stays in Postgres.
  const { data, error, status } = await getSupabase()
    .from("page_text")
    .select("storage_key, text, source, edited_at, pages!inner(diary_id)")
    .eq("pages.diary_id", diaryId);

  if (error)
    throw outageOr(error, `Could not read page text from Supabase: ${error.message}`, status);

  const byContentId = new Map();
  for (const row of data ?? []) {
    byContentId.set(contentIdFor(row.storage_key), {
      text: row.text,
      source: row.source,
      editedAt: row.edited_at ?? null,
    });
  }
  return byContentId;
}

/**
 * Write recognised or corrected text for one scan.
 *
 * Upsert, because recognition is re-runnable by design: a page that already has
 * text should end with the newer result, not a unique violation. `edited_at` is
 * set only for a human correction, which is what makes "skip anything a human
 * touched" answerable on a later run.
 */
export async function setPageText(storageKey, text, source) {
  if (typeof storageKey !== "string" || storageKey === "") {
    throw new Error("setPageText needs a storage key.");
  }
  if (!TEXT_SOURCES.includes(source)) {
    throw new Error(`Unknown text source: ${source}`);
  }

  const { getSupabase } = await import("./supabase.js");

  const { error, status } = await getSupabase().from("page_text").upsert(
    {
      storage_key: storageKey,
      text,
      source,
      edited_at: source === "manual" ? new Date().toISOString() : null,
    },
    { onConflict: "storage_key" }
  );

  if (error) throw outageOr(error, `Could not save page text: ${error.message}`, status);
}

/**
 * Remove the text for one scan.
 *
 * Clearing the box in the page index means "there is no usable text here",
 * which is a different statement from an empty string -- and leaving an empty
 * row behind would make a later run skip the page as already done.
 */
export async function clearPageText(storageKey) {
  const { getSupabase } = await import("./supabase.js");

  const { error, status } = await getSupabase()
    .from("page_text")
    .delete()
    .eq("storage_key", storageKey);

  if (error) throw outageOr(error, `Could not clear page text: ${error.message}`, status);
}

/**
 * The storage key for one page, for callers that only have its number.
 *
 * Kept here rather than exported from pages.js because the key is deliberately
 * absent from what getPages() returns -- it never goes to the browser. The two
 * server-side callers that genuinely need it (the admin action, which is given
 * a page number by a form, and the recognition script) get it from here.
 */
export async function storageKeyOf(diaryId, pageId) {
  const { getSupabase } = await import("./supabase.js");

  const { data, error, status } = await getSupabase()
    .from("pages")
    .select("storage_key")
    .eq("diary_id", diaryId)
    .eq("page_id", pageId)
    .maybeSingle();

  if (error) throw outageOr(error, `Could not find that page: ${error.message}`, status);
  return data?.storage_key ?? null;
}
