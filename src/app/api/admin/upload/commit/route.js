import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";

import { getAuthState } from "@/lib/auth";
import { nextFreePageId } from "@/lib/ingest";
import {
  discard,
  readDerived,
  readMaster,
  readPlan,
  writePlan,
} from "@/lib/ingest-staging";
import { storageKeyFor } from "@/lib/pages";
import { BUCKET, getSupabase } from "@/lib/supabase";
import { SCANS_DIR, uploadCapability } from "@/lib/uploads";

const MANIFEST_FILE = path.join(process.cwd(), "src", "lib", "manifest.generated.json");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Step two: actually add the pages.
 *
 * Takes only a staging id and a page count per index. Everything else -- the
 * image bytes, the master filenames, the dimensions -- is read back from the
 * plan the server wrote, so nothing the browser sends can redirect a write.
 */
export async function POST(request) {
  // getAuthState() rather than getCurrentUser(), which flattens "cannot reach
  // Supabase" and "not signed in" to the same null. They need different answers
  // now that the proxy no longer separates them for these paths.
  const { user, outage } = await getAuthState();
  if (outage) return unavailable();
  if (!user) return json({ ok: false, message: "Unauthorized." }, 401);
  if (!user.isAdmin) return json({ ok: false, message: "Admins only." }, 403);

  // Checked here as well as in the plan step. A commit is a separate request to
  // a separate endpoint, and nothing says the plan it names was made by a
  // server that could do this one.
  const uploads = await uploadCapability();
  if (!uploads.enabled) return json({ ok: false, message: uploads.reason }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Malformed request." }, 400);
  }

  const { stagingId, items, diaryId: rawDiaryId } = body ?? {};

  // Which book these pages join. Validated here rather than trusted, and used
  // for the storage key prefix as well as the row, so two diaries can both have
  // a page 1 without colliding in the bucket.
  const diaryId = Number(rawDiaryId);
  if (!Number.isInteger(diaryId) || diaryId < 1) {
    return json({ ok: false, message: "Invalid volume." }, 400);
  }

  let plan;
  try {
    plan = await readPlan(stagingId);
  } catch (error) {
    // Thrown by stagingDir() for an id that is not 32 hex characters.
    return json({ ok: false, message: error.message }, 400);
  }
  if (!plan) {
    return json(
      { ok: false, message: "That upload has expired. Choose the file again." },
      410
    );
  }

  // The submitted counts are matched positionally against the server's plan;
  // anything else in the array is ignored.
  const counts = new Map();
  if (Array.isArray(items)) {
    for (const item of items) {
      const index = Number(item?.index);
      const pageCount = Number(item?.pageCount);
      if (Number.isInteger(index) && (pageCount === 1 || pageCount === 2)) {
        counts.set(index, pageCount);
      }
    }
  }

  const supabase = getSupabase();
  let pageId;
  try {
    pageId = await nextFreePageId(supabase, diaryId);
  } catch (error) {
    return json({ ok: false, message: error.message }, 502);
  }

  const added = [];
  const masters = [];

  // One page at a time, copied from the script: an interruption leaves at most
  // one page ambiguous rather than a half-written batch. Whatever succeeded
  // before a failure stays -- it is already a real page -- and is reported.
  for (const item of plan.items) {
    const pageCount = counts.get(item.index) ?? item.pageCount;
    const key = storageKeyFor(pageId, diaryId);

    try {
      const bytes = await readDerived(stagingId, item.index);

      // upsert:false so a key already in use fails loudly. Two admins uploading
      // at once would otherwise race on the same next-free page number.
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(key, bytes, { contentType: "image/jpeg", upsert: false });
      if (uploadError) throw new Error(`upload of ${key} failed: ${uploadError.message}`);

      const { error: rowError } = await supabase.from("pages").insert({
        diary_id: diaryId,
        page_id: pageId,
        storage_key: key,
        page_count: pageCount,
        width: item.width,
        height: item.height,
        byte_size: item.byteSize,
        // first_line is typed in later from /admin/pages.
      });
      if (rowError) {
        // The object is already up but has no row pointing at it; drop it so a
        // retry can reuse the key rather than colliding with an orphan.
        await supabase.storage.from(BUCKET).remove([key]);
        throw new Error(`row for page ${pageId} failed: ${rowError.message}`);
      }
    } catch (error) {
      // Drop the items that already landed from the staged plan before
      // answering. Without this, pressing Add again would replay the batch from
      // the beginning -- nextFreePageId() has moved past the pages that
      // succeeded, so they would be added a second time, and appending is the
      // only operation the uploader has. Now a retry resumes from here.
      const remaining = plan.items.slice(added.length);

      // The pages before the failure are real, so their masters belong in
      // images/ too. Doing this only on the success path left images/ silently
      // incomplete for exactly those pages -- the opposite of the promise that
      // it holds the full-resolution copy of everything.
      const savedBeforeFailure = await saveMasters(stagingId, masters);

      try {
        await writePlan(stagingId, { ...plan, items: remaining });
      } catch {
        // If the plan cannot be rewritten, a retry could duplicate, so make
        // retrying impossible instead.
        await discard(stagingId);
      }

      revalidatePath("/");
      revalidatePath("/admin", "layout");

      return json(
        {
          ok: false,
          added,
          remaining,
          mastersSaved: savedBeforeFailure,
          message:
            `Stopped at ${item.label}: ${error.message}` +
            (added.length
              ? ` The ${added.length} page(s) before it were added and will not be repeated.`
              : ""),
        },
        502
      );
    }

    masters.push({ item, pageId, pageCount, storageKey: key });
    added.push({ label: item.label, pageId, pageCount });
    pageId += pageCount;
  }

  // Best effort, and after the pages are safely in: keeping images/ complete
  // matters because what went to Supabase is capped at MAX_WIDTH, so this is the
  // only full resolution copy. A deployment with no writable source tree simply
  // skips it -- that is not a reason to fail an upload that already succeeded.
  const mastersSaved = await saveMasters(stagingId, masters);

  await discard(stagingId);

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");

  return json({
    ok: true,
    added,
    mastersSaved,
    message:
      `Added ${added.length} page${added.length === 1 ? "" : "s"}, ` +
      `now ending at page ${pageId - 1}.`,
  });
}

/**
 * Copy each master into images/ and regenerate the manifest.
 *
 * Deliberately never overwrites: a name that already exists gets a numeric
 * suffix. The script refuses outright in that situation, but it can tell you to
 * rename and re-run, whereas here the pages are already added and failing would
 * leave the diary and the folder disagreeing.
 */
async function saveMasters(stagingId, entries) {
  if (entries.length === 0) return 0;

  try {
    await access(SCANS_DIR);
  } catch {
    return 0;
  }

  let saved = 0;
  const manifestAdditions = [];

  for (const { item, pageId, pageCount, storageKey } of entries) {
    try {
      const bytes = await readMaster(stagingId, item.index, item.masterExt);
      if (!bytes) continue;

      const fileName = await freeName(item.masterName);
      await writeFile(path.join(SCANS_DIR, fileName), bytes);
      saved += 1;

      manifestAdditions.push({
        file: fileName,
        // The join back to a database row. `file` means nothing to Postgres and
        // `pageId` changes whenever pages are reordered, so neither can be it.
        storageKey,
        pageId,
        pageCount,
        width: item.sourceWidth,
        height: item.sourceHeight,
      });
    } catch {
      // One master failing to land should not abandon the rest.
    }
  }

  if (manifestAdditions.length) {
    try {
      const existing = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
      const merged = [...existing, ...manifestAdditions].sort((a, b) => a.pageId - b.pageId);
      await writeFile(MANIFEST_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    } catch {
      // No manifest yet (a fresh clone has neither images/ nor one).
    }
  }

  return saved;
}

/** `name.jpg`, or `name-2.jpg` if that is taken, and so on. */
async function freeName(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);

  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? name : `${base}-${n}${ext}`;
    try {
      await access(path.join(SCANS_DIR, candidate));
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/**
 * 503 for a project that is paused or otherwise unreachable.
 *
 * The proxy used to supply this for every /api/ path. These two routes are no
 * longer matched by it -- see the comment on the matcher in src/proxy.js -- so
 * they answer it themselves. Without this an outage would arrive as 401, and
 * "Unauthorized" sends an admin to check their session for a problem that is
 * not theirs. Retry-After says the honest thing: waiting is the fix.
 */
function unavailable() {
  return Response.json(
    { ok: false, message: "Bookshelf is temporarily unavailable. Try again in a few minutes." },
    { status: 503, headers: { "Retry-After": "300", "Cache-Control": "no-store" } }
  );
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
