/**
 * Matching first lines, as pure functions.
 *
 * One rule, used by three surfaces -- the live filter in the viewer, the
 * shareable /search page, and the admin page index -- so they cannot drift
 * apart. Deliberately no database and no React: the semantics below are the
 * kind of thing that is easy to get subtly wrong, and this way they can be
 * exercised directly.
 *
 * Filtering happens in the app rather than in Postgres because getPages()
 * already loads every row's metadata on every render. Doing it in SQL would
 * mean two matching rules -- ilike folds case by its own collation and would
 * quietly disagree with the filter running in the browser. See docs/design.md for
 * the point at which that trade stops being worth it.
 */

/**
 * Case- and accent-insensitive form of one character, ALWAYS one character long.
 *
 * Length preservation is the whole point. highlight() finds matches in the
 * folded text and slices the ORIGINAL at those offsets, so folding has to be a
 * one-for-one mapping. Running normalize("NFD") over a whole string is not:
 * "é" becomes two code points, and every offset after it shifts, which would
 * mark the wrong letters. Anything that would not fold to exactly one character
 * -- "ß", ligatures, "İ" in some engines -- is left as-is instead.
 */
function foldChar(ch) {
  const stripped = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (stripped.length === 1) return stripped;

  const lowered = ch.toLowerCase();
  return lowered.length === 1 ? lowered : ch;
}

/** Foldable form of a string, the same length as the original. */
export function fold(text) {
  // Array.from, not split(""), so an astral character (emoji) stays one unit
  // here -- but it is still two UTF-16 code units in the original string, so
  // the pieces are rejoined and the surrogate pair survives intact.
  return Array.from(text ?? "", foldChar).join("");
}

/** The query split into terms, folded. Empty for a blank query. */
function termsOf(query) {
  return fold(query ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does this text match the query?
 *
 * Terms are ANDed and matched as substrings, so "electrical student" finds
 * "electrical engi student". A blank query matches NOTHING rather than
 * everything: an empty search box should show no results, not the whole diary.
 */
export function matchesQuery(text, query) {
  const terms = termsOf(query);
  if (terms.length === 0) return false;
  if (!text) return false;

  const folded = fold(text);
  return terms.every((term) => folded.includes(term));
}

/** Pages whose first line matches, in reading order. Pages with none never match. */
export function searchPages(pages, query) {
  if (termsOf(query).length === 0) return [];
  return pages.filter((page) => matchesQuery(page.firstLine, query));
}

/** How many pages have a first line at all -- what search coverage depends on. */
export function coverage(pages) {
  const filled = pages.filter((page) => page.firstLine).length;
  return { filled, total: pages.length, blank: pages.length - filled };
}

/**
 * Pages whose first line OR recognised text matches.
 *
 * The same matchesQuery() as everything else -- this adds a second place to
 * look, not a second rule. `textByPage` is a Map keyed by contentId, as
 * getPageText() returns; a page with no entry is simply matched on its first
 * line, which is what every page did before recognition existed.
 *
 * Only the shareable /search page passes a map. The viewer's live filter
 * deliberately does not: it filters pages already in memory, and page text is
 * kept out of that payload on purpose.
 */
export function searchPagesWithText(pages, textByPage, query) {
  if (termsOf(query).length === 0) return [];
  return pages.filter(
    (page) =>
      matchesQuery(page.firstLine, query) ||
      matchesQuery(textByPage?.get(page.contentId)?.text, query)
  );
}

/**
 * A line of recognised text worth showing as the hit.
 *
 * Two passes, because terms are ANDed across the whole page but rarely all land
 * on one line: "melee attack" can match a page where "melee" is a heading and
 * "attack" is three lines down. The first pass looks for a line carrying the
 * whole query, which is the best excerpt when it exists; the second settles for
 * a line carrying any one term, which is still the right part of the page to
 * show. Null when neither finds anything, and the caller falls back.
 */
export function matchingLine(text, query) {
  const terms = termsOf(query);
  if (terms.length === 0 || !text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const whole = lines.find((line) => matchesQuery(line, query));
  if (whole) return whole;

  return lines.find((line) => terms.some((term) => fold(line).includes(term))) ?? null;
}

/**
 * Split text into [{ text, hit }] segments so matches can be marked.
 *
 * Offsets come from the folded text and are applied to the original, which is
 * only sound because fold() preserves length. Overlapping hits from different
 * terms are merged, so searching "art heart" does not produce nested marks.
 */
export function highlight(text, query) {
  if (!text) return [];
  const terms = termsOf(query);
  if (terms.length === 0) return [{ text, hit: false }];

  const folded = fold(text);

  const ranges = [];
  for (const term of terms) {
    let from = folded.indexOf(term);
    while (from !== -1) {
      ranges.push([from, from + term.length]);
      from = folded.indexOf(term, from + 1);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const segments = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });

  return segments;
}
