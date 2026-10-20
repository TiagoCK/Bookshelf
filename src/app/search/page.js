import Link from "next/link";

import HighlightedLine from "@/components/HighlightedLine";
import { requireUser } from "@/lib/auth";
import { getDiaries } from "@/lib/diaries";
import { getPages } from "@/lib/pages";
import { getPageText } from "@/lib/page-text";
import { matchesQuery, matchingLine, searchPagesWithText } from "@/lib/search";

export const dynamic = "force-dynamic";

/**
 * Search every diary by first line, at a URL you can bookmark and send.
 *
 * A plain GET form rather than a client-side filter: this is the version that
 * survives being pasted into a message, and it works with JavaScript off. The
 * viewer has its own live filter for searching the book you are reading; both
 * call searchPages(), so they always agree about what matches.
 *
 * Deliberately across all volumes. Searching one book at a time would mean
 * remembering which one an entry was in, which is the thing you use search to
 * avoid.
 */
export default async function SearchPage({ searchParams }) {
  // Checked here, not just in the proxy -- see src/proxy.js.
  const user = await requireUser("/search");

  const params = await searchParams;
  const raw = params.q;
  const query = (Array.isArray(raw) ? raw[0] : raw ?? "").toString();

  const diaries = await getDiaries(user);
  const perDiary = await Promise.all(
    diaries.map(async (diary) => {
      const pages = await getPages(diary.id);
      // Loaded here and nowhere else. getPages() runs on every render of the
      // reader; this is a second read on the one page that actually searches.
      const textByPage = await getPageText(diary.id);
      return { diary, pages, textByPage, matches: searchPagesWithText(pages, textByPage, query) };
    })
  );

  const matched = perDiary.filter((entry) => entry.matches.length > 0);
  const total = matched.reduce((n, entry) => n + entry.matches.length, 0);

  // Searchable means findable by either route now, so counting first lines
  // alone would badly understate it -- a volume can be fully searchable with
  // not one first line typed.
  const findable = perDiary.reduce(
    (n, e) => n + e.pages.filter((p) => p.firstLine || e.textByPage.has(p.contentId)).length,
    0
  );
  const allPages = perDiary.reduce((n, e) => n + e.pages.length, 0);
  const searched = query.trim() !== "";

  return (
    <section className="searchpage">
      <h2>Search</h2>

      <form className="searchpage__form" method="get" action="/search">
        <label className="searchpage__label" htmlFor="q">
          Page contains
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="a word from anywhere on the page&hellip;"
          autoComplete="off"
        />
        <button type="submit">Search</button>
      </form>

      <p className="admin__note">
        {findable} of {allPages} scans can be found &mdash; by a typed first
        line, or by text recognised from the page itself
        {user.isAdmin ? (
          <>
            . Run <code>npm run ocr</code> to recognise more, and correct it
            from each volume&rsquo;s <Link href="/admin">page index</Link>.
          </>
        ) : (
          "."
        )}
      </p>

      {!searched ? (
        <p className="searchpage__empty">Type something to search for.</p>
      ) : total === 0 ? (
        <p className="searchpage__empty">
          Nothing matches <strong>{query}</strong>.
        </p>
      ) : (
        <>
          <p className="searchpage__count">
            {total} {total === 1 ? "match" : "matches"}
            {matched.length > 1 && ` across ${matched.length} volumes`}
          </p>

          {matched.map(({ diary, matches, textByPage }) => (
            <section key={diary.id} className="searchpage__group">
              {/* Grouped by volume, and only labelled when there is more than
                  one -- a heading over the single group you already know you
                  are in is noise. */}
              {diaries.length > 1 && (
                <h3 className="searchpage__diary">
                  <Link href={`/d/${diary.slug}`}>{diary.title}</Link>
                </h3>
              )}

              <ul className="searchpage__list">
                {matches.map((page) => {
                  const span =
                    page.pageCount === 1
                      ? `Page ${page.pageId}`
                      : `Pages ${page.pageId}–${page.pageId + page.pageCount - 1}`;
                  const excerpt = excerptFor(page, textByPage.get(page.contentId)?.text, query);
                  return (
                    <li key={page.contentId} className="searchpage__row">
                      {/* Opens that diary, already turned to this page. */}
                      <Link
                        className="searchpage__hit"
                        href={`/d/${diary.slug}?page=${page.pageId}`}
                      >
                        <img
                          className="order__thumb"
                          src={page.src}
                          alt=""
                          width={page.width}
                          height={page.height}
                          loading="lazy"
                          decoding="async"
                        />
                        <span className="searchpage__meta">
                          <span className="order__span">{span}</span>
                          <HighlightedLine text={excerpt.text} query={query} />
                          {/* Said only when the hit came from the page body.
                              A first-line hit is the thing the line is for and
                              needs no label; a body hit is a quotation from
                              recognised text, which can be wrong, and the
                              reader deserves to know which they are reading. */}
                          {excerpt.fromText && (
                            <span className="searchpage__from">from the page</span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}


/**
 * What to show as the hit: the first line, or the line of the page that matched.
 *
 * The first line wins when it matches, because it is the curated summary and is
 * the one text here that a human wrote. Otherwise the match is somewhere in the
 * body, and showing the first line instead would present a result with no
 * visible reason for being one.
 */
function excerptFor(page, text, query) {
  if (matchesQuery(page.firstLine, query)) {
    return { text: page.firstLine, fromText: false };
  }
  const line = matchingLine(text, query);
  if (line) return { text: line, fromText: true };

  // Matched the page as a whole but no single line carries a term -- possible
  // with an accent or a hyphen split across lines. Fall back to something
  // rather than an empty row.
  return { text: page.firstLine ?? "", fromText: Boolean(text) };
}
