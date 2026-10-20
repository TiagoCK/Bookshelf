import { readFile } from "node:fs/promises";
import path from "node:path";
import { canSee, DEFAULT_VISIBILITY } from "@/lib/diary-rules";
import { DIARY_SOURCE, findLocalPage } from "@/lib/pages";
import { getAuthState } from "@/lib/auth";
import { isOutage } from "@/lib/outage.js";

const SCANS_DIR = path.join(process.cwd(), "images");

/**
 * Serves the image for one diary page.
 *
 * This route is the indirection layer that keeps the rest of the app unaware of
 * where images live. It is keyed by page number, never by filename or storage
 * key, so nothing about the storage layout reaches the browser.
 *
 *   local     page number -> manifest -> file on disk, streamed
 *   supabase  page number -> row -> signed Storage URL, redirected to
 *
 * Either way the caller just requests /api/scan/<pageId>.
 *
 * This route serves the actual scan images, which makes it the most important
 * thing to protect. It decides for itself rather than trusting the proxy: if the
 * proxy were ever bypassed, this is the endpoint that would hand over everything.
 *
 * It no longer requires a session, because a volume marked `public` must be
 * readable without one. What it requires instead is canSee(), against the
 * visibility that arrives with the row -- so an anonymous caller gets a public
 * volume's images and a 404 for anything else. The permission question moved; it
 * did not go away.
 */
export async function GET(request, { params }) {
  // The viewer may be nobody, and that is no longer a refusal on its own --
  // canSee() decides further down, once the row says how visible the volume is.
  //
  // An unreachable project is still its own answer. It is not that this caller
  // may not have the image; it is that nobody can be identified and no image can
  // be fetched, which is a 503 and not a 404.
  const { user, outage } = await getAuthState();
  if (outage) return unavailable();

  const { diaryId: rawDiary, pageId: raw } = await params;

  // Reject anything that is not a plain positive integer before it can reach a
  // filesystem path or a query. Both segments, not just the page: the diary is
  // now half of what identifies an image.
  if (!/^\d+$/.test(raw) || !/^\d+$/.test(rawDiary)) return notFound();
  const pageId = Number(raw);
  const diaryId = Number(rawDiary);

  if (DIARY_SOURCE === "local") {
    /*
     * Local mode reads the manifest, which has no notion of volumes or of
     * visibility -- there is no row here to ask canSee() about, and this branch
     * never reaches the canSee() in serveFromSupabase().
     *
     * That made it a hole the moment the session check above was removed: every
     * scan on disk would have been readable by anyone. The single volume local
     * mode serves is declared as DEFAULT_VISIBILITY in src/lib/diaries.js, so
     * apply exactly that rule and let it follow if the default ever changes.
     */
    if (!canSee({ visibility: DEFAULT_VISIBILITY }, user)) return notFound();
    return serveFromDisk(pageId);
  }

  return serveFromSupabase(diaryId, pageId, user);
}

async function serveFromDisk(pageId) {
  // The manifest is the allowlist: a page number that is not in it never
  // reaches readFile, so no caller-supplied string is joined onto a path.
  const page = findLocalPage(pageId);
  if (!page) return notFound();

  try {
    const bytes = await readFile(path.join(SCANS_DIR, page.file));
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return notFound();
  }
}

async function serveFromSupabase(diaryId, pageId, viewer) {
  const { getSupabase, BUCKET, SIGNED_URL_TTL_SECONDS } = await import("@/lib/supabase");
  const supabase = getSupabase();

  /*
   * The diary's visibility comes back with the page, in one query.
   *
   * This is the boundary that actually matters. The shelf and search filter
   * hidden diaries out of what a reader is *shown*, but neither stops a reader
   * requesting /api/scan/<id>/1 directly and reading the images anyway. Page
   * numbers start at 1 in every volume, so guessing costs nothing.
   */
  // `status` as well: postgrest-js keeps the HTTP status on the response.
  const { data: row, error, status } = await supabase
    .from("pages")
    .select("storage_key, diaries!inner(visibility)")
    .eq("diary_id", diaryId)
    .eq("page_id", pageId)
    .maybeSingle();

  if (error) {
    console.error(`scan route: diary ${diaryId} page ${pageId} lookup failed:`, error.message);
    return isOutage(error, status) ? unavailable() : upstreamError();
  }
  if (!row) return notFound();

  /*
   * 404 rather than 403, matching /d/<slug>: a refusal that distinguishes "no
   * such volume" from "not yours" tells a caller which ids are worth trying.
   *
   * This is now the only thing standing between an anonymous request and a
   * private image, since the session check above went away. `viewer` is null for
   * such a request, and canSee() returns true only for `public`.
   */
  if (!canSee(row.diaries, viewer)) return notFound();

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_key, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    console.error(`scan route: signing ${row.storage_key} failed:`, signError?.message);
    return isOutage(signError) ? unavailable() : upstreamError();
  }

  // no-store is required, not just polite: a cached redirect would outlive the
  // signed URL it points at and start handing out links that 400.
  return new Response(null, {
    status: 302,
    headers: { Location: signed.signedUrl, "Cache-Control": "no-store" },
  });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

function upstreamError() {
  return new Response("Upstream error", { status: 502 });
}

/**
 * 503 for a project that is paused or otherwise unreachable.
 *
 * Distinct from the 502 above, which means Supabase answered and the answer was
 * broken. Retry-After is the useful part: it says waiting is the fix, which is
 * true of a paused project and not of a genuine fault. no-store so a proxy
 * cannot keep serving the outage after the project comes back.
 */
function unavailable() {
  return new Response("Bookshelf is temporarily unavailable", {
    status: 503,
    headers: { "Retry-After": "300", "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";
