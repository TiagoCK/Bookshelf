/**
 * Data access for diary pages.
 *
 * This module is the seam between the viewer and wherever the scans live.
 * Two sources are supported, chosen by the DIARY_SOURCE environment variable:
 *
 *   supabase (default)  page rows from Postgres, images from private Storage
 *   local               the manifest below, images streamed from images/
 *
 * The switch is explicit rather than an automatic fallback: a Supabase free-tier
 * project pauses after about a week of inactivity, and silently serving stale
 * local data in that case would be far more confusing than a loud failure.
 */

// Pure and dependency-free, so a static import here pulls in nothing else --
// unlike ./supabase.js below, which stays lazy so local mode needs no keys.
import { outageOr } from "./outage.js";

/** Which backing store to read from. */
export const DIARY_SOURCE = process.env.DIARY_SOURCE === "local" ? "local" : "supabase";

/**
 * The diary to assume when nothing says otherwise.
 *
 * Not "the diary" any more -- every request-facing path takes a diary id
 * explicitly, resolved from the slug in the URL. This remains for the two
 * callers with no request to resolve from: the add-pages CLI, and local mode,
 * which reads a manifest off disk and has only ever had one book.
 */
export const DEFAULT_DIARY_ID = 1;

/**
 * The local scans, in order. Written by scripts/add-pages.mjs -- never by hand.
 *
 *   file      the name in images/
 *   pageId    first physical page number this scan covers
 *   pageCount 1 for a single page, 2 for an open spread
 *   width     the LOCAL file's display dimensions, EXIF applied
 *   height
 *
 * These are the local file's dimensions, which are not always the database's:
 * a scan wider than 2400px is downscaled on upload, so the published image is
 * smaller than the master sitting in images/. Local mode serves the master, so
 * it needs the master's numbers.
 *
 * Gitignored, like images/ itself. Both exist only on the machine holding the
 * scans, so a fresh clone has neither and local mode has nothing to serve --
 * hence the empty fallback rather than a hard failure.
 */
export const MANIFEST = await loadManifest();

/**
 * Read, not import.
 *
 * An import would put this file in the module graph, and the uploader rewrites
 * it on every commit -- which made the dev server tear down and re-evaluate
 * this module, and everything importing it, in the middle of the request doing
 * the writing. Reading it keeps the data identical and the graph static.
 *
 * This module is server-only (src/lib/views.js exists so client components
 * never reach it), so node:fs here costs nothing on the browser side.
 */
async function loadManifest() {
  try {
    const [{ readFile }, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const file = path.join(process.cwd(), "src", "lib", "manifest.generated.json");
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

/** Storage object key for a page. Zero-padded so keys sort in reading order. */
export function storageKeyFor(pageId, diaryId = DEFAULT_DIARY_ID) {
  return `diary${diaryId}/${String(pageId).padStart(4, "0")}.jpg`;
}

/**
 * A stable, opaque id for the scan itself, as opposed to where it currently sits.
 *
 * Page numbers are not identity: reordering rewrites every page_id while leaving
 * the same SET of numbers in place, so a UI keyed on page numbers sees no change
 * at all and quietly keeps showing the previous occupant of each slot. The
 * storage key is the thing that never moves, but it must not reach the browser,
 * so this hashes it.
 *
 * FNV-1a, inline rather than node:crypto -- a hash used only to tell two rows
 * apart has no reason to pull in a Node builtin.
 *
 * Two passes with different seeds, concatenated, rather than one. A single
 * 32-bit hash collides with probability around 0.6% across the ~6,800 pages the
 * free tier holds, and a collision here is not cosmetic: two rows would share a
 * React key, so /admin/pages would reuse one row's uncontrolled text box for
 * both and Save would write a first line onto the wrong scan -- exactly the
 * corruption this id was introduced to prevent. Sixty-four bits puts that back
 * in the realm of never.
 */
export function contentIdFor(storageKey) {
  const fnv = (seed) => {
    let hash = seed;
    for (let i = 0; i < storageKey.length; i += 1) {
      hash ^= storageKey.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
}

/** The local file backing a page number, or undefined. Used by the scan route. */
export function findLocalPage(pageId) {
  return MANIFEST.find((page) => page.pageId === pageId);
}

/**
 * URL for a page's image.
 *
 * Deliberately synchronous and deliberately not a storage URL. Minting a signed
 * Supabase URL is async and the result expires, so returning one here would make
 * buildViews() async and push changes up into the viewer. Routing through our
 * own endpoint keeps this a pure function, mints signed URLs only for pages
 * someone actually looks at, and keeps storage keys out of the browser.
 */
export function getPageImageUrl(page) {
  // ?v= identifies WHICH scan and WHICH version of it, so the URL changes both
  // when a scan is edited and when a different scan moves into this page number.
  //
  // The edit timestamp alone is not enough. Reordering does not touch it, and
  // most scans have never been edited, so swapping two of those produced two
  // byte-identical URLs -- React wrote no new src, the browser never re-fetched,
  // and both pages kept showing the scan that used to be there.
  const version = page.updatedAt ? Date.parse(page.updatedAt) : 0;
  const token = version ? `${page.contentId}-${version}` : page.contentId;

  // Scoped by diary, not just page number. Page numbers restart at 1 in every
  // book, so /api/scan/7 stopped identifying anything the moment a second
  // volume existed -- it would have served whichever book answered first.
  return `/api/scan/${page.diaryId}/${page.pageId}?v=${token}`;
}

/**
 * Ordered page records for one diary. Metadata only -- no image bytes.
 *
 * The diary id is required rather than defaulted: a page number means nothing
 * on its own now that two books both have a page 7, and a silent default is
 * exactly how one book would start serving another's pages.
 */
export async function getPages(diaryId) {
  if (!Number.isInteger(diaryId)) {
    throw new Error("getPages needs a diary id.");
  }
  const rows =
    DIARY_SOURCE === "local" ? readLocalPages(diaryId) : await readSupabasePages(diaryId);
  return rows.map((page) => ({ ...page, src: getPageImageUrl(page) }));
}

function readLocalPages(diaryId) {
  return MANIFEST.map((page) => ({
    pageId: page.pageId,
    diaryId,
    contentId: contentIdFor(page.storageKey ?? page.file),
    pageCount: page.pageCount,
    width: page.width,
    height: page.height,
    firstLine: null,
    hasOriginal: false,
    rotation: 0,
    crop: null,
    updatedAt: null,
    isRedacted: false,
  }));
}

async function readSupabasePages(diaryId) {
  const { getSupabase } = await import("./supabase.js");
  // `status` as well as `error`: postgrest-js leaves the HTTP status on the
  // response, so a paused project's 540 is invisible from the error alone.
  const { data, error, status } = await getSupabase()
    .from("pages")
    // select("*") rather than a column list, deliberately. Naming columns makes
    // the app hard-fail the moment the code is ahead of the database -- the gap
    // between deploying a change and running its migration -- and the failure is
    // total, because every page calls this. With "*" a not-yet-added column is
    // simply absent and the mapping below falls back to a default.
    .select("*")
    .eq("diary_id", diaryId)
    .order("page_id", { ascending: true });

  if (error)
    throw outageOr(error, `Could not read pages from Supabase: ${error.message}`, status);

  return (data ?? []).map((row) => ({
    pageId: row.page_id,
    diaryId: row.diary_id,
    // Derived, never the key itself: the browser learns that two rows differ,
    // and nothing about the storage layout.
    contentId: contentIdFor(row.storage_key),
    pageCount: row.page_count,
    width: row.width,
    height: row.height,
    firstLine: row.first_line,
    hasOriginal: Boolean(row.original_key),
    rotation: row.edit_rotation ?? 0,
    crop: row.edit_crop ?? null,
    updatedAt: row.updated_at ?? null,
    isRedacted: Boolean(row.redacted_at),
  }));
}
