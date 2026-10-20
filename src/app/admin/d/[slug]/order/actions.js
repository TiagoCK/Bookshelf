"use server";

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { DIARY_SOURCE } from "@/lib/pages";
import {
  classifyTarget,
  describeSpan,
  projectSpans,
  reorderedKeys,
} from "@/lib/ordering";
import { getSupabase } from "@/lib/supabase";

const MANIFEST_FILE = path.join(process.cwd(), "src", "lib", "manifest.generated.json");

async function loadPages(diaryId) {
  const { data, error } = await getSupabase()
    .from("pages")
    .select("page_id, page_count, storage_key")
    .eq("diary_id", diaryId)
    .order("page_id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    pageId: row.page_id,
    pageCount: row.page_count,
    storageKey: row.storage_key,
  }));
}

/**
 * Move a scan to a given page number, swapping with whatever starts there.
 *
 * requireAdmin() runs here rather than only on the page that renders the form:
 * a server action is a publicly reachable endpoint of its own.
 */
export async function movePage(_prevState, formData) {
  await requireAdmin();

  const diaryId = Number(formData.get("diaryId"));
  if (!Number.isInteger(diaryId) || diaryId < 1) {
    return { ok: false, message: "Invalid volume." };
  }

  const pageId = Number(formData.get("pageId"));
  const rawTarget = (formData.get("target") ?? "").toString().trim();

  if (!Number.isInteger(pageId) || pageId < 1) {
    return { ok: false, message: "Invalid page." };
  }
  if (rawTarget === "" || !/^\d+$/.test(rawTarget)) {
    return { ok: false, message: "Enter a page number." };
  }
  const target = Number(rawTarget);

  const pages = await loadPages(diaryId);
  const moving = pages.find((page) => page.pageId === pageId);
  if (!moving) return { ok: false, message: "No such page." };

  const found = classifyTarget(pages, target);

  if (found.kind === "out-of-range") {
    return {
      ok: false,
      message: `Page ${target} is outside the volume, which runs 1–${found.max}.`,
    };
  }

  // Half of this diary's page numbers are the second half of a spread, so this
  // is the common outcome rather than an edge case. Name the scan that owns the
  // number and where to aim instead.
  if (found.kind === "interior") {
    return {
      ok: false,
      message:
        `Page ${target} isn't the start of a scan — it's part of the image at ` +
        `${describeSpan(found.owner)}, which begins on page ${found.owner.start}. ` +
        `Use ${found.owner.start} to swap with that scan.`,
    };
  }

  if (found.owner.pageId === pageId) {
    return { ok: false, message: `That scan is already at ${describeSpan(found.owner)}.` };
  }

  const keys = reorderedKeys(pages, pageId, target);
  if (!keys) return { ok: false, message: "Could not work out the new order." };

  const spans = projectSpans(pages, keys);

  const { error } = await getSupabase().rpc("reorder_diary_pages", {
    p_diary_id: diaryId,
    p_keys: keys,
  });
  if (error) return { ok: false, message: error.message };

  // Only local mode reads the manifest. Writing it in supabase mode rewrote a
  // file that src/lib/pages.js imports at module scope, so every reorder made
  // the dev server recompile in the middle of the action that triggered it.
  if (DIARY_SOURCE === "local") await syncManifest(spans);

  revalidatePath("/");
  // The whole admin subtree, not four named routes: /admin/editor/[pageId] is
  // addressed by page number, so after a reorder an open editor is pointed at a
  // different scan than the one it loaded.
  revalidatePath("/admin", "layout");

  const landed = spans.find((span) => span.storageKey === moving.storageKey);
  const swapped = spans.find((span) => span.storageKey === found.owner.storageKey);

  // When the two scans are different sizes the moved one cannot land exactly on
  // the number requested, so say where it went rather than implying it worked
  // as asked.
  const note =
    landed.start === target
      ? ""
      : ` (not ${target} — the two scans are different sizes, so the numbering shifted)`;

  return {
    ok: true,
    message:
      `Moved to ${describeSpan(landed)}${note}. ` +
      `The scan that was there is now at ${describeSpan(swapped)}.`,
  };
}

/**
 * Keep the local-mode manifest in step with the new order.
 *
 * The manifest is joined to the database on storageKey; `file` is meaningless
 * to Postgres and `pageId` is the thing that just changed. Failure is ignored
 * on purpose -- local mode is an offline convenience, and a deployment with no
 * writable source tree should not fail a reorder over it.
 */
async function syncManifest(spans) {
  try {
    const raw = await readFile(MANIFEST_FILE, "utf8");
    const entries = JSON.parse(raw);
    const byKey = new Map(spans.map((span) => [span.storageKey, span]));

    const updated = entries
      .map((entry) => {
        const span = entry.storageKey ? byKey.get(entry.storageKey) : undefined;
        return span ? { ...entry, pageId: span.pageId } : entry;
      })
      .sort((a, b) => a.pageId - b.pageId);

    await writeFile(MANIFEST_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  } catch {
    // Nothing to keep in step, or nowhere to write it.
  }
}
