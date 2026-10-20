import Link from "next/link";

import ActionForm from "@/components/ActionForm";
import { requireAdmin } from "@/lib/auth";
import { createDiary, deleteDiary, setDiaryVisibility } from "@/app/admin/actions";
import { getDiaries } from "@/lib/diaries";
import { getPages } from "@/lib/pages";
import { coverage } from "@/lib/search";
import { totalPages } from "@/lib/views";

export const dynamic = "force-dynamic";

/**
 * The admin shelf.
 *
 * Everything except People belongs to a particular diary, so this is where you
 * say which one. It used to redirect straight to the page index, which only
 * made sense while there was exactly one book to edit.
 */
export default async function AdminIndex() {
  const admin = await requireAdmin();

  const diaries = await getDiaries(admin);
  const shelf = await Promise.all(
    diaries.map(async (diary) => {
      const pages = await getPages(diary.id);
      return { diary, pages: totalPages(pages), rows: pages.length, ...coverage(pages) };
    })
  );

  return (
    <>
      <h2>Volumes</h2>
      <p className="admin__note">
        Page index, order, upload and the image editor all belong to one volume.
        Choose which.
      </p>

      {shelf.length === 0 && (
        <p className="admin__note">
          No volumes yet. Create the first one below.
        </p>
      )}

      <ul className="adminshelf">
        {shelf.map(({ diary, pages, rows, filled, total }) => (
          <li key={diary.id} className="adminshelf__item">
            <div className="adminshelf__head">
              <Link className="adminshelf__title" href={`/d/${diary.slug}`}>
                {diary.title}
              </Link>
              <span className="adminshelf__meta">
                {pages === 0 ? "no pages" : `${pages} pages`}
                {total > 0 && ` · ${filled}/${total} scans have a first line`}
                <code className="adminshelf__slug">/d/{diary.slug}</code>
                {diary.visibility === "admins" && (
                  <span className="badge badge--admin">admins only</span>
                )}
                {diary.visibility === "public" && (
                  <span className="badge badge--public">public</span>
                )}
              </span>
            </div>

            <nav className="adminshelf__links">
              <Link href={`/admin/d/${diary.slug}/pages`}>Page index</Link>
              <Link href={`/admin/d/${diary.slug}/upload`}>Upload</Link>
              <Link href={`/admin/d/${diary.slug}/editor`}>Image editor</Link>
              <Link href={`/admin/d/${diary.slug}/order`}>Order</Link>

              {/* Only offered while the diary is empty. Deleting one with pages
                  would strand their storage objects, which SQL cannot reach --
                  the foreign key refuses it too, but not offering the button is
                  a better answer than explaining a constraint violation. */}
              {/* This was one button that stated what it would do, which is
                  clearer than a select -- but only while there were two values.
                  With three it would have to guess which one you meant, so it
                  is a select plus Save after all. The current value is the
                  selected option, so the control also reports the state. */}
              <ActionForm action={setDiaryVisibility} className="adminshelf__visibility">
                <input type="hidden" name="diaryId" value={diary.id} />
                <label>
                  Who can open it
                  <select name="visibility" defaultValue={diary.visibility}>
                    <option value="public">Anyone, no account</option>
                    <option value="readers">Anyone signed in</option>
                    <option value="admins">Admins only</option>
                  </select>
                </label>
                <button type="submit">Save</button>
              </ActionForm>

              {rows === 0 && (
                <ActionForm action={deleteDiary} className="adminshelf__remove">
                  <input type="hidden" name="diaryId" value={diary.id} />
                  <button type="submit">Remove</button>
                </ActionForm>
              )}
            </nav>
          </li>
        ))}
      </ul>

      <section className="newdiary">
        <h3>New volume</h3>
        <p className="admin__note">
          The address is derived from the title unless you set one. It becomes
          the URL, so it is worth keeping short.
        </p>

        <ActionForm action={createDiary} className="newdiary__form">
          <label htmlFor="new-title">Title</label>
          <input
            id="new-title"
            name="title"
            type="text"
            required
            maxLength={120}
            placeholder="Second Notebook"
          />

          <label htmlFor="new-subtitle">Subtitle (optional)</label>
          <input
            id="new-subtitle"
            name="subtitle"
            type="text"
            maxLength={200}
            placeholder="1998–2001"
          />

          <label htmlFor="new-slug">Address (optional)</label>
          <input
            id="new-slug"
            name="slug"
            type="text"
            maxLength={60}
            placeholder="second-notebook"
            /* Not pattern-validated in the browser: prepareDiary() tidies
               "My Trip!" into "my-trip" rather than rejecting it, and a native
               validation bubble would block the submit before it could. */
            autoComplete="off"
          />

          <span className="newdiary__label">Who can open it</span>
          <span className="newdiary__radios">
            {/* "Anyone signed in" stays the default. A new volume should never
                become world-readable because nobody touched this. */}
            <label>
              <input type="radio" name="visibility" value="readers" defaultChecked />
              Anyone signed in
            </label>
            <label>
              <input type="radio" name="visibility" value="admins" />
              Admins only
            </label>
            <label>
              <input type="radio" name="visibility" value="public" />
              Anyone, no account
            </label>
          </span>

          <button type="submit">Add volume</button>
        </ActionForm>
      </section>
    </>
  );
}
