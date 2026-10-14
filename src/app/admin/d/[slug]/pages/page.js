import Link from "next/link";

import { requireAdmin } from "@/lib/auth";
import { getPages } from "@/lib/pages";
import { getPageText } from "@/lib/page-text";
import { coverage, searchPages } from "@/lib/search";
import ActionForm from "@/components/ActionForm";
import HighlightedLine from "@/components/HighlightedLine";
import { requireDiary } from "@/lib/diaries";
import { updateFirstLine, updatePageText } from "@/app/admin/actions";

export const dynamic = "force-dynamic";

export default async function PageIndex({ params, searchParams }) {
  const admin = await requireAdmin();
  const { slug } = await params;
  const diary = await requireDiary(slug, admin);

  const search = await searchParams;
  const raw = search.q;
  const query = (Array.isArray(raw) ? raw[0] : raw ?? "").toString();
  const blankOnly = search.blank === "1";

  const pages = await getPages(diary.id);
  const { filled, total, blank } = coverage(pages);

  // Keyed on contentId, the same identifier getPages() derives, so the two line
  // up without the storage key ever reaching this component.
  const textByPage = await getPageText(diary.id);

  // Blank-only wins over the query: a scan with no first line cannot match a
  // search, so combining them could only ever return nothing.
  const shown = blankOnly
    ? pages.filter((page) => !page.firstLine)
    : query.trim() !== ""
      ? searchPages(pages, query)
      : pages;

  return (
    <>
      <h2>Page index — {diary.title}</h2>
      <p className="admin__note">
        The first line of each scan, and the text recognised from it. A spread
        covers two pages &mdash; use the left-hand page and stay consistent.
      </p>

      <form className="pagesearch" method="get" action={`/admin/d/${diary.slug}/pages`}>
        <label className="pagesearch__label" htmlFor="q">
          Search first lines
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="a word from the first line&hellip;"
          autoComplete="off"
        />
        <button type="submit">Search</button>
        {/* Plain links, not a second form: this whole page is a GET, so the
            filters are just URLs and both survive JavaScript being off. */}
        <Link
          className={`pagesearch__toggle${blankOnly ? " pagesearch__toggle--on" : ""}`}
          href={blankOnly ? `/admin/d/${diary.slug}/pages` : `/admin/d/${diary.slug}/pages?blank=1`}
        >
          {blankOnly ? "Show all" : `Show blank only (${blank})`}
        </Link>
      </form>

      <p className="admin__note">
        <strong>
          {filled} of {total}
        </strong>{" "}
        scans have a first line. A scan can also be found by its recognised
        text, from the <Link href="/search">search page</Link> &mdash; run{" "}
        <code>npm run ocr</code> to fill that in.
        {blankOnly && " Saving a line removes that scan from this list."}
      </p>

      {shown.length === 0 ? (
        <p className="admin__note">
          {blankOnly ? "Every scan has a first line." : `Nothing matches ${query}.`}
        </p>
      ) : (
        <ul className="admin__list">
          {shown.map((page) => {
            const span =
              page.pageCount === 1
                ? `Page ${page.pageId}`
                : `Pages ${page.pageId}–${page.pageId + page.pageCount - 1}`;
            return (
              // Keyed on the scan, not the page number. The text box is
              // uncontrolled, and defaultValue only applies when it mounts -- so
              // if a row were reused across a reorder it would keep the previous
              // occupant's text and Save would write it onto the wrong scan.
              // Keying this way makes React move the whole row, box included.
              <li key={page.contentId} className="admin__row">
                <ActionForm action={updateFirstLine}>
                  <input type="hidden" name="diaryId" value={diary.id} />
                  <input type="hidden" name="pageId" value={page.pageId} />
                  <span className="admin__span">{span}</span>
                  <input
                    type="text"
                    name="firstLine"
                    defaultValue={page.firstLine ?? ""}
                    placeholder="First line&hellip;"
                    maxLength={500}
                    aria-label={`First line for ${span}`}
                  />
                  <button type="submit">Save</button>
                </ActionForm>
                {/* Shown beside the editable box, not inside it: marking up the
                    match has to happen outside an input's value. */}
                {query.trim() !== "" && !blankOnly && page.firstLine && (
                  <HighlightedLine
                    text={page.firstLine}
                    query={query}
                    className="admin__match"
                  />
                )}

                {/*
                  Behind a disclosure, closed by default. A volume is dozens of
                  scans and a page of recognised text is thousands of
                  characters; rendering them all expanded would bury the first
                  lines this page exists to edit. The summary carries enough to
                  tell at a glance whether a page has text and roughly what it
                  says.
                */}
                <details className="admin__text">
                  <summary>
                    {recognised(textByPage, page) ? (
                      <>
                        <span className="admin__source">
                          {textByPage.get(page.contentId).source}
                        </span>{" "}
                        {preview(textByPage.get(page.contentId).text)}
                      </>
                    ) : (
                      "No recognised text"
                    )}
                  </summary>
                  <ActionForm action={updatePageText} className="admin__textform">
                    <input type="hidden" name="diaryId" value={diary.id} />
                    <input type="hidden" name="pageId" value={page.pageId} />
                    <textarea
                      name="pageText"
                      rows={10}
                      defaultValue={textByPage.get(page.contentId)?.text ?? ""}
                      placeholder="Recognised text&hellip;"
                      aria-label={`Recognised text for ${span}`}
                    />
                    <button type="submit">Save text</button>
                  </ActionForm>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Does this scan have recognised text at all? */
function recognised(textByPage, page) {
  return textByPage.has(page.contentId);
}

/**
 * Enough of the text to recognise the page from, on one line.
 *
 * Not firstLineOf(): that skips lines with nothing readable in them, which is
 * right for a searchable summary and wrong here -- if recognition returned
 * nothing but noise, this is the place you want to see it.
 */
function preview(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}\u2026` : flat;
}
