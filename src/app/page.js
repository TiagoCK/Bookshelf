import Link from "next/link";
import { redirect } from "next/navigation";

import { getViewer, orPaused } from "@/lib/auth";
import { getDiaries } from "@/lib/diaries";
import { getPages } from "@/lib/pages";
import { totalPages } from "@/lib/views";

export const dynamic = "force-dynamic";

/**
 * The shelf.
 *
 * No volume lives at the root any more. That is the point: the first diary was
 * only ever at "/" because it was the only one, and every book added after it
 * would have been a second-class citizen at a different shape of URL.
 */
export default async function Shelf() {
  // May be nobody. getDiaries() filters through canSee(), so an anonymous
  // visitor is handed the `public` volumes and nothing else.
  const user = await getViewer();
  const diaries = await orPaused(() => getDiaries(user));

  if (diaries.length === 0) {
    return (
      <section className="shelf">
        <h2>Nothing on the shelf yet</h2>
        <p className="admin__note">
          {/*
            Three audiences, and the third is new: a visitor with no account at
            all, who reaches this when no volume is marked `public`. Telling
            them nothing is published would be true but dead-ended, so they get
            the way in. `user?.` because this page no longer guarantees a user.
          */}
          {user?.isAdmin ? (
            <>
              Create one from the <Link href="/admin">admin section</Link>, then
              upload its scans.
            </>
          ) : user ? (
            "Nothing has been published here yet."
          ) : (
            <>
              Nothing is public here yet. <Link href="/login">Sign in</Link> if
              you have an account.
            </>
          )}
        </p>
      </section>
    );
  }

  // One book on the shelf is a shelf you should not have to click through.
  if (diaries.length === 1) redirect(`/d/${diaries[0].slug}`);

  // A query per diary rather than one big one. It reuses getPages() exactly as
  // the reader does -- same mapping, same image URLs, same contentId -- and at
  // a shelf's worth of books the extra round trips cost less than a second
  // mapping that could disagree with the first.
  const shelf = await orPaused(() =>
    Promise.all(
      diaries.map(async (diary) => {
        const pages = await getPages(diary.id);
        return { diary, cover: pages[0] ?? null, pages: totalPages(pages) };
      })
    )
  );

  return (
    <section className="shelf">
      <h2>Volumes</h2>

      <ul className="shelf__list">
        {shelf.map(({ diary, cover, pages }) => (
          <li key={diary.id} className="shelf__item">
            <Link className="shelf__link" href={`/d/${diary.slug}`}>
              {/* The first page is the cover. A separate cover image would be
                  another thing to upload, keep in step and get wrong. */}
              {cover ? (
                <img
                  className="shelf__cover"
                  src={cover.src}
                  alt=""
                  width={cover.width}
                  height={cover.height}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span className="shelf__cover shelf__cover--empty" aria-hidden="true" />
              )}

              <span className="shelf__meta">
                <span className="shelf__title">{diary.title}</span>
                {diary.subtitle && (
                  <span className="shelf__subtitle">{diary.subtitle}</span>
                )}
                <span className="shelf__count">
                  {pages === 0 ? "No pages yet" : `${pages} pages`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
