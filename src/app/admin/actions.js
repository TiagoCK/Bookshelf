"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { DIARY_SOURCE } from "@/lib/pages";
import { normaliseVisibility, prepareDiary } from "@/lib/diary-rules";
import { getSupabase } from "@/lib/supabase";
import { clearPageText, setPageText, storageKeyOf } from "@/lib/page-text";

const MAX_FIRST_LINE = 500;
const ROLES = ["reader", "admin"];

/**
 * Update one page's first_line.
 *
 * requireAdmin() runs HERE, not only on the page that renders the form. A server
 * action is a publicly reachable endpoint with its own generated URL -- guarding
 * the page that shows the form does nothing to guard the action behind it.
 */
export async function updateFirstLine(_prevState, formData) {
  await requireAdmin();

  const pageId = Number(formData.get("pageId"));
  if (!Number.isInteger(pageId) || pageId < 1) {
    return { ok: false, message: "Invalid page." };
  }

  // Which book. A page number identifies nothing on its own now that every
  // diary starts at page 1, so without this a first line could be written onto
  // the same-numbered page of a different volume.
  const diaryId = Number(formData.get("diaryId"));
  if (!Number.isInteger(diaryId) || diaryId < 1) {
    return { ok: false, message: "Invalid diary." };
  }

  const raw = (formData.get("firstLine") ?? "").toString().trim();
  if (raw.length > MAX_FIRST_LINE) {
    return { ok: false, message: `Too long (max ${MAX_FIRST_LINE} characters).` };
  }

  const { error } = await getSupabase()
    .from("pages")
    .update({ first_line: raw === "" ? null : raw })
    .eq("diary_id", diaryId)
    .eq("page_id", pageId);

  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin", "layout");
  return { ok: true, message: "Saved." };
}

/**
 * Save a correction to one scan's recognised text.
 *
 * Recognition is never right on handwriting, so the text has to be editable --
 * and an edit has to survive the next run. Writing it with source 'manual' is
 * what makes that answerable: the script skips anything a human has touched,
 * so re-running recognition over a volume is always safe.
 *
 * Identified by diary and page number, like updateFirstLine, and the storage
 * key is looked up here. The key is deliberately absent from everything
 * getPages() hands the browser, and a form field is the browser.
 */
export async function updatePageText(_prevState, formData) {
  await requireAdmin();

  const pageId = Number(formData.get("pageId"));
  const diaryId = Number(formData.get("diaryId"));
  if (!Number.isInteger(pageId) || pageId < 1) return { ok: false, message: "Invalid page." };
  if (!Number.isInteger(diaryId) || diaryId < 1) return { ok: false, message: "Invalid diary." };

  const text = (formData.get("pageText") ?? "").toString().trim();

  try {
    const storageKey = await storageKeyOf(diaryId, pageId);
    if (!storageKey) return { ok: false, message: "No such page." };

    if (text === "") {
      await clearPageText(storageKey);
      revalidatePath("/admin", "layout");
      return { ok: true, message: "Text removed." };
    }

    await setPageText(storageKey, text, "manual");
  } catch (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/search");
  return { ok: true, message: "Saved." };
}

/**
 * Set another user's role.
 *
 * Upserts rather than updates: nothing creates profile rows automatically (see
 * src/lib/auth.js), so a user who has never signed in has no row yet, and
 * promoting them before their first login has to work.
 */
export async function setUserRole(_prevState, formData) {
  const admin = await requireAdmin();

  const userId = (formData.get("userId") ?? "").toString();
  const role = (formData.get("role") ?? "").toString();

  if (!ROLES.includes(role)) return { ok: false, message: "Unknown role." };

  // Without this an admin can demote themselves, and if they are the only admin
  // nobody can ever assign the role again -- the app has no other way in.
  //
  // This one check is sufficient. Only an admin reaches this action, so the
  // caller is always in the admin list, and demoting anyone else therefore
  // leaves at least the caller. A count of remaining admins would be
  // unreachable code.
  if (userId === admin.id) {
    return { ok: false, message: "You cannot change your own role." };
  }

  const db = getSupabase();
  const { data: user, error: lookupError } = await db.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) return { ok: false, message: "No such user." };

  const { error } = await db
    .from("profiles")
    .upsert({ id: userId, email: user.user.email, role }, { onConflict: "id" });

  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/people");
  return { ok: true, message: "Saved." };
}

/**
 * Create a diary.
 *
 * Until now a second volume meant an INSERT in the Supabase dashboard, which is
 * exactly the kind of thing the admin section exists to avoid. The naming rules
 * live in src/lib/diary-rules.js so they can be tested; this is the part that
 * needs a database.
 */
export async function createDiary(_prevState, formData) {
  await requireAdmin();

  if (DIARY_SOURCE === "local") {
    return { ok: false, message: "Local mode has no database to create a diary in." };
  }

  const prepared = prepareDiary({
    title: formData.get("title"),
    slug: formData.get("slug"),
    subtitle: formData.get("subtitle"),
  });
  if (!prepared.ok) return { ok: false, message: prepared.message };

  const db = getSupabase();

  // Appended to the shelf. Reading the last position rather than counting rows:
  // positions are deliberately independent of ids, so a diary reordered or
  // removed must not make the next one collide.
  const { data: last, error: readError } = await db
    .from("diaries")
    .select("position")
    .order("position", { ascending: false })
    .limit(1);
  if (readError) return { ok: false, message: readError.message };

  const { data, error } = await db
    .from("diaries")
    .insert({
      ...prepared.diary,
      visibility: normaliseVisibility(formData.get("visibility")),
      position: (last?.[0]?.position ?? 0) + 1,
    })
    .select()
    .maybeSingle();

  if (error) {
    // 23505 is a unique violation, which here can only be the slug.
    if (error.code === "23505") {
      return {
        ok: false,
        message: `The address /d/${prepared.diary.slug} is already taken. Choose another.`,
      };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message: `Created ${data.title} at /d/${data.slug}. Add scans from its Upload tab.`,
  };
}

/**
 * Remove a diary, but only while it is empty.
 *
 * The counterpart to creating one: without it, a typo in a slug would send you
 * back to the dashboard, which is what this pair is meant to replace. Empty
 * only, because deleting a book with pages would orphan storage objects that
 * SQL cannot reach -- the foreign key refuses it too, but a counted check gives
 * an admin something to act on instead of a constraint violation.
 */
export async function deleteDiary(_prevState, formData) {
  await requireAdmin();

  const diaryId = Number(formData.get("diaryId"));
  if (!Number.isInteger(diaryId) || diaryId < 1) {
    return { ok: false, message: "Invalid diary." };
  }

  const db = getSupabase();
  const { count, error: countError } = await db
    .from("pages")
    .select("page_id", { count: "exact", head: true })
    .eq("diary_id", diaryId);
  if (countError) return { ok: false, message: countError.message };

  if (count > 0) {
    // Scans, not pages: this counts rows, and a row covering a spread is two
    // page numbers. Saying "14 pages" of a diary whose counter reads 26 would
    // send someone looking for a discrepancy that is not there.
    return {
      ok: false,
      message: `That diary still has ${count} scan${count === 1 ? "" : "s"}. Remove them first.`,
    };
  }

  const { error } = await db.from("diaries").delete().eq("id", diaryId);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Diary removed." };
}

/**
 * Change who may open a diary.
 *
 * Separate from createDiary because it is the one you reach for after the fact:
 * a volume starts readable and later becomes private, or the reverse when a
 * synthetic one is ready to show.
 */
export async function setDiaryVisibility(_prevState, formData) {
  await requireAdmin();

  const diaryId = Number(formData.get("diaryId"));
  if (!Number.isInteger(diaryId) || diaryId < 1) {
    return { ok: false, message: "Invalid diary." };
  }

  // normaliseVisibility falls back to "readers" for anything unrecognised, so a
  // tampered form cannot invent a value the CHECK constraint would reject --
  // and cannot accidentally open a diary by sending nonsense either, since the
  // fallback is the value the column already defaults to.
  const visibility = normaliseVisibility(formData.get("visibility"));

  const { data, error } = await getSupabase()
    .from("diaries")
    .update({ visibility })
    .eq("id", diaryId)
    .select("title")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "No such diary." };

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message:
      visibility === "admins"
        ? `${data.title} is now visible to admins only.`
        : `${data.title} is now visible to everyone signed in.`,
  };
}
