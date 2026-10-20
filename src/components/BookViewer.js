"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import HighlightedLine from "@/components/HighlightedLine";
import PageZoom from "@/components/PageZoom";
import { searchPages } from "@/lib/search";
import { buildHalves, halfOf, initialViewIndex, viewIndexForPage } from "@/lib/views";

const FLIP_MS = 600;

/** Enough to be useful without turning the viewer into a list; the rest are counted. */
const MAX_RESULTS = 8;

/**
 * The remembered page number, or null.
 *
 * Returns null on the server and wherever storage is unavailable -- a private
 * window and a browser configured to block site data both throw on access
 * rather than returning nothing.
 */
function readRemembered(key) {
  if (!key || typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Book or scroll, and where that choice is kept.
 *
 * localStorage, not sessionStorage, and one key for every volume: how someone
 * likes to read is a preference about them, not a position in a particular
 * book. Picking the scrolling column once should still be the choice next week,
 * and in the next volume.
 *
 * Same failure handling as readRemembered() -- a private window throws on
 * access rather than returning nothing -- and an unrecognised stored value
 * falls back to the book rather than rendering a mode that does not exist.
 */
const MODE_KEY = "bookshelf:view-mode";
const MODES = ["book", "scroll"];
const DEFAULT_MODE = "book";

function readMode() {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    return MODES.includes(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * A slot in the open book that opens the zoom when clicked.
 *
 * A button rather than a div with a handler, so it is reachable by keyboard and
 * announced as something that does a thing. A blank facing page is left inert.
 */
function ZoomableSlot({ className, half, onOpen, busy, lazy = false, style }) {
  if (!half) {
    return (
      <div className={className} style={style}>
        <Half half={half} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`${className} slot--zoomable`}
      style={style}
      onClick={() => onOpen(half.page)}
      disabled={busy}
      aria-label={
        half.page.pageCount === 1
          ? `Enlarge page ${half.page.pageId}`
          : `Enlarge pages ${half.page.pageId}–${half.page.pageId + half.page.pageCount - 1}`
      }
    >
      <Half half={half} lazy={lazy} />
    </button>
  );
}

/** One half of the open book: half a spread, a whole single page, or blank. */
function Half({ half, lazy = false }) {
  if (!half) return <div className="half half--blank" aria-hidden="true" />;

  const { page, clip } = half;
  return (
    <div className={`half ${clip ? `half--clip-${clip}` : "half--whole"}`}>
      {/* Plain <img>: the clipping relies on absolute positioning, and browsers
          apply these files' EXIF rotation natively. width/height are the
          display dimensions, so the box is reserved before the bytes land. */}
      {/*
        lazy is opt-in rather than always on, because the two modes want
        opposite things. The book renders one view and prefetches its
        neighbours, so its images must start immediately. The column renders
        every page at once, and each one costs two requests -- /api/scan is a
        redirect to a signed URL -- so loading them all on open would fire the
        whole volume at a reader who may scroll three pages.
      */}
      <img
        src={page.src}
        width={page.width}
        height={page.height}
        alt=""
        draggable="false"
        decoding="async"
        loading={lazy ? "lazy" : undefined}
      />
    </div>
  );
}

export default function BookViewer({
  views,
  totalPages,
  animate = true,
  renderToolbar,
  initialIndex = 0,
  linkedPage = null,
  rememberKey = null,
}) {
  // Only the starting point. /?page=N is resolved on the server; the component
  // is keyed on it there, so arriving at a second deep link remounts rather
  // than being ignored by this initialiser.
  const [index, setIndex] = useState(initialIndex);
  // null at rest; otherwise { dir, target, phase } for the flip in flight.
  const [flip, setFlip] = useState(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [jumpError, setJumpError] = useState("");
  const [query, setQuery] = useState("");

  /*
   * Book or scrolling column.
   *
   * Starts at the default on both sides and is corrected after mount, for the
   * same reason the remembered position is: this decides what gets rendered, so
   * reading storage during render would have the server and the client disagree
   * about what they produced.
   */
  const [mode, setMode] = useState(DEFAULT_MODE);

  // The top-most page visible in the column, tracked while scrolling. Null in
  // book mode and until the first observation lands.
  const [scrollPage, setScrollPage] = useState(null);

  // The scan being examined full-window, or null. Held here rather than in the
  // slots so Escape, the controls and a page turn all speak to one thing.
  const [zoomed, setZoomed] = useState(null);

  // The admin editor turns the flip off: 600ms per step is tiring when you are
  // stepping through looking for scans to fix. Reuses the reduced-motion branch
  // below rather than introducing a second way to skip the animation.
  const skipAnimation = !animate || reducedMotion;

  /*
   * The page the reader is on, whichever mode they are in.
   *
   * This is the single idea both modes report into and that everything else --
   * the counter, the remembered position, ?page=, the mode toggle -- reads. The
   * book knows it from its frame; the column from what is scrolled into view.
   * Keeping it one value is what makes switching modes a lookup rather than a
   * translation layer.
   */
  const bookPageNumber = views[index]?.pages[0].pageId ?? null;
  const currentPageNumber =
    mode === "scroll" ? (scrollPage ?? bookPageNumber) : bookPageNumber;

  // Mirrors `flip` so callbacks can read it without going stale.
  const flipRef = useRef(null);
  const columnRef = useRef(null);
  const visibleRef = useRef(new Set());
  const leafRef = useRef(null);
  const timerRef = useRef(null);
  const jumpId = useId();
  const searchId = useId();

  // Results are per PAGE, not per view: a paired view holds two single pages
  // with a first line each, and saying which one matched is the useful part.
  const allPages = useMemo(() => views.flatMap((view) => view.pages), [views]);

  // One item per physical page. Only used by the column, but cheap and stable,
  // so it is not worth branching the memo on mode.
  const halves = useMemo(() => buildHalves(views), [views]);
  const matches = useMemo(() => searchPages(allPages, query), [allPages, query]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  /*
   * The stored position, captured during the FIRST render.
   *
   * Not read inside the restore effect, which is the obvious place and is
   * wrong: the effect that records the position runs before it -- passive
   * effects for the first render flush before a layout effect's state update
   * re-renders -- so by then storage already says page 1, and the restore
   * "succeeds" onto the page it was supposed to move away from. Strict Mode
   * makes it visible by running the mount effect twice, but the race is real
   * without it.
   *
   * Capturing here takes the read out of that ordering entirely. Undefined on
   * the server and never used for rendered output, so hydration is unaffected.
   */
  const rememberedRef = useRef(undefined);
  if (rememberedRef.current === undefined) {
    rememberedRef.current = readRemembered(rememberKey);
  }
  const restoredRef = useRef(false);

  /*
   * Reopen where this reading session left off.
   *
   * A layout effect, not a plain one: it runs before the browser paints, so
   * page 1 never flashes on the way to page 11. Mount only -- returning to "/"
   * from anywhere unmounts this component, which is exactly when the position
   * needs restoring.
   *
   * initialViewIndex() decides; a ?page= link that already resolved on the
   * server wins, and this defers to it.
   */
  useLayoutEffect(() => {
    if (!rememberKey) return;

    const { index: target, source } = initialViewIndex(views, {
      linkedPage,
      rememberedPage: rememberedRef.current,
    });

    // sessionStorage is an external store the server cannot see, so this
    // cannot be resolved during render without the server and the client
    // disagreeing about what they rendered. Correcting once, before paint, is
    // the trade: one extra render, no hydration mismatch, no visible flash.
    if (source === "remembered") setIndex(target);
    restoredRef.current = true;

    // Mount only, deliberately: after this the position is written, never read
    // back, so re-running on every `views` change would fight the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Apply the stored mode before the first paint.
   *
   * Same shape and same reason as the position restore above: this decides what
   * is rendered, so it cannot be resolved during render without the server and
   * the client disagreeing. One extra render, no hydration mismatch.
   */
  useLayoutEffect(() => {
    const stored = readMode();
    // The cascading render the linter warns about is the mechanism here, as it
    // is for the leaf below: the server has already rendered the default, and
    // correcting it before paint is precisely what avoids both a hydration
    // mismatch and a visible flash of the wrong mode. Resolving it during
    // render is the thing that cannot work.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored !== DEFAULT_MODE) setMode(stored);
    // Mount only. Afterwards the toggle is the only thing that changes it.
  }, []);

  /*
   * Which page the column is showing.
   *
   * An observer rather than a scroll handler: it reports only when something
   * crosses the edge, off the main thread, instead of recomputing on every
   * scroll event.
   *
   * The visible set is kept in a ref and the answer taken from all of it,
   * because a callback reports only what CHANGED. Reading the top-most page out
   * of `entries` alone would jump to whichever page happened to cross the
   * boundary, not the one being read.
   */
  useEffect(() => {
    if (mode !== "scroll") return;
    const root = columnRef.current;
    if (!root) return;

    visibleRef.current = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number(entry.target.dataset.pageNumber);
          if (!Number.isInteger(number)) continue;
          if (entry.isIntersecting) visibleRef.current.add(number);
          else visibleRef.current.delete(number);
        }
        if (visibleRef.current.size > 0) {
          setScrollPage(Math.min(...visibleRef.current));
        }
      },
      { root, threshold: 0 }
    );

    for (const el of root.querySelectorAll("[data-page-number]")) observer.observe(el);
    return () => observer.disconnect();
  }, [mode, halves]);

  /*
   * Opening the column lands on the page the reader was already on.
   *
   * bookPageNumber, not currentPageNumber: at this moment scrollPage is still
   * null, so they are the same value, and depending on the derived one would
   * re-run this as the reader scrolls and drag them back to where they started.
   */
  const columnOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (mode !== "scroll") return;
    const root = columnRef.current;
    if (!root) return;

    /*
     * Which page to land on depends on how the column got here.
     *
     * On a toggle, it is where the book was. On the first open of a session --
     * the mode was restored from the preference, not chosen -- it is the exact
     * page that was stored, which can be finer than the book can express: a
     * frame reports its first page, so restoring through initialViewIndex alone
     * turns "I was on page 4" into page 3, the facing half of the same spread.
     * The column stores exact numbers, so it should honour them.
     */
    const remembered = Number(rememberedRef.current);
    const exact =
      !columnOpenedRef.current && halves.some((half) => half.pageNumber === remembered)
        ? remembered
        : bookPageNumber;
    columnOpenedRef.current = true;

    if (exact == null) return;
    const el = root.querySelector(`[data-page-number="${exact}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /*
   * Record the position, and keep the address bar honest about it.
   *
   * The page NUMBER is stored rather than the frame index, because an index
   * means nothing once a page is added, removed or reordered -- and it is the
   * vocabulary ?page= already speaks, so there is one idea here, not two.
   *
   * replaceState rather than a router navigation: a page turn must not add a
   * history entry, and must not re-run the server component.
   */
  useEffect(() => {
    // Nothing is written until the restore has had its say, so a tab closed in
    // that first instant does not lose the position it was about to reopen.
    if (!rememberKey || !restoredRef.current) return;

    // currentPageNumber rather than the frame, so scrolling the column records
    // the position exactly as turning a leaf does.
    const pageNumber = currentPageNumber;
    if (pageNumber == null) return;

    try {
      window.sessionStorage.setItem(rememberKey, String(pageNumber));
    } catch {
      // Storage unavailable; the URL below still carries the position.
    }

    const url = new URL(window.location.href);
    if (url.searchParams.get("page") !== String(pageNumber)) {
      url.searchParams.set("page", String(pageNumber));
      window.history.replaceState(null, "", url);
    }
  }, [currentPageNumber, rememberKey]);

  const settle = useCallback(() => {
    const active = flipRef.current;
    if (!active) return;
    clearTimeout(timerRef.current);
    flipRef.current = null;
    setIndex(active.target);
    setFlip(null);
  }, []);

  /** Move to a view by index, animating only when it is the next one along. */
  const goToIndex = useCallback(
    (target) => {
      // A flip already running owns the leaf; a second one would animate from
      // a half-rotated state.
      if (flipRef.current) return;
      if (target < 0 || target >= views.length || target === index) return;

      const step = target - index;

      // The leaf turns exactly one view, so a jump further than that has no
      // leaf to turn and lands directly.
      if (skipAnimation || Math.abs(step) !== 1) {
        setIndex(target);
        return;
      }

      const next = { dir: step === 1 ? "next" : "prev", target, phase: "start" };
      flipRef.current = next;
      setFlip(next);

      // Settle even if the transition never reports finishing. A backgrounded
      // tab freezes rAF and throttles transitions, so without this the leaf
      // would hang mid-turn and leave navigation permanently disabled.
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(settle, FLIP_MS + 150);
    },
    [index, views.length, skipAnimation, settle]
  );

  const go = useCallback(
    (dir) => goToIndex(dir === "next" ? index + 1 : index - 1),
    [goToIndex, index]
  );

  /** Scroll the column by one page. What Prev/Next mean when there is no leaf. */
  const scrollByPage = useCallback(
    (dir) => {
      const root = columnRef.current;
      if (root == null || currentPageNumber == null) return;

      const at = halves.findIndex((half) => half.pageNumber === currentPageNumber);
      const target = halves[at + (dir === "next" ? 1 : -1)];
      if (!target) return;

      const el = root.querySelector(`[data-page-number="${target.pageNumber}"]`);
      // Instant, not smooth: the reader asked for a page, and a 300ms glide
      // fights a second press. Honours reduced motion for free.
      if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
    },
    [halves, currentPageNumber]
  );

  /**
   * Go to a page number, in whichever mode is showing.
   *
   * The jump field, the search hits and the mode toggle all want this, and all
   * of them think in page numbers -- so the branch lives here once rather than
   * at each call site.
   */
  const goToPage = useCallback(
    (pageNumber) => {
      if (mode === "scroll") {
        const el = columnRef.current?.querySelector(
          `[data-page-number="${pageNumber}"]`
        );
        if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
      const target = viewIndexForPage(views, pageNumber);
      if (target >= 0) goToIndex(target);
    },
    [mode, views, goToIndex]
  );

  /*
   * Swap modes without losing the place.
   *
   * Both modes speak page numbers, so this is a lookup rather than a
   * translation: into the book, resolve the number to its frame; into the
   * column, the effect above scrolls to it. The preference is written here
   * rather than in an effect, because it should record a deliberate choice and
   * not the mode a restore happened to apply.
   */
  const toggleMode = useCallback(() => {
    const next = mode === "book" ? "scroll" : "book";

    if (next === "book" && currentPageNumber != null) {
      const target = viewIndexForPage(views, currentPageNumber);
      if (target >= 0) setIndex(target);
    }

    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Storage unavailable; the mode still applies for this visit.
    }
  }, [mode, currentPageNumber, views]);

  // Commit the leaf's starting angle before moving it, or the browser collapses
  // both styles into one recalculation and nothing animates. Reading the
  // computed style forces that flush; rAF would be tidier but never fires while
  // the tab is hidden.
  useLayoutEffect(() => {
    if (flip?.phase !== "start") return;
    if (leafRef.current) getComputedStyle(leafRef.current).transform;
    const running = { ...flip, phase: "run" };
    flipRef.current = running;
    // The cascading render the linter warns about is the mechanism here, not a
    // mistake: the leaf has to be committed at its starting angle with no
    // transition, the browser has to recalculate, and only then can the angle
    // change with a transition attached. One render cannot express that, and
    // adjusting state during render would not give the browser its flush.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlip(running);
  }, [flip]);

  useEffect(() => {
    const onKey = (event) => {
      // Left and Right are caret movement inside a text field, and the jump
      // input sits in these very controls. Without this, typing a page number
      // would flip the book and preventDefault() would freeze the caret.
      const el = event.target;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT")
      ) {
        return;
      }

      if (event.key === "ArrowRight") go("next");
      else if (event.key === "ArrowLeft") go("prev");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const onJump = (event) => {
    event.preventDefault();
    if (flipRef.current) return;

    const raw = jumpValue.trim();
    const numeric = /^\d+$/.test(raw);
    const target = numeric ? viewIndexForPage(views, Number(raw)) : -1;

    if (target < 0) {
      // A number inside the range that still matches no view means a gap left
      // by a deleted page. Saying so beats repeating the range back at someone
      // who already typed something inside it.
      setJumpError(
        numeric && Number(raw) >= 1 && Number(raw) <= totalPages
          ? `There is no page ${raw} in this volume.`
          : `Pages run 1–${totalPages}.`
      );
      return;
    }

    // Cleared rather than left showing what was typed: the counter beside it
    // already says where you are, and the field is ready for the next jump.
    setJumpError("");
    setJumpValue("");
    // The validation above still asks viewIndexForPage, because a number with
    // no frame has no page either -- but the move itself goes through goToPage
    // so it lands in the column when that is what is showing.
    goToPage(Number(raw));
  };

  // An empty diary is a reachable state -- a fresh project before the first
  // upload, or every page deleted. Without this, views[0] is undefined and
  // reading current.label below throws, taking down both the reader and the
  // admin editor with a 500 and no way back from inside the app.
  const current = views[index];
  if (!current) {
    return (
      <div className="viewer">
        <p className="admin__note">
          No pages yet. Drop scans into <code>images/incoming/</code> and run{" "}
          <code>npm run add -- --commit</code>.
        </p>
      </div>
    );
  }

  const target = flip ? views[flip.target] : null;
  const forward = flip?.dir === "next";

  // While a leaf turns, one static side already belongs to the view being
  // revealed: turning forward uncovers the next view's right side, turning back
  // uncovers the previous view's left side.
  const leftHalf = halfOf(flip && !forward ? target : current, "left");
  const rightHalf = halfOf(flip && forward ? target : current, "right");

  // The back face is what shows once the leaf passes vertical.
  const leafFront = forward ? halfOf(current, "right") : halfOf(target, "right");
  const leafBack = forward ? halfOf(target, "left") : halfOf(current, "left");

  const atStart = flip?.phase === "start";
  const leafAngle = flip && (forward ? !atStart : atStart) ? -180 : 0;

  const neighbours = [views[index - 1], views[index + 1]].filter(Boolean);

  /*
   * What the controls mean in each mode. Computed here so the JSX below reads
   * the same in both -- Previous is Previous whether it turns a leaf or scrolls
   * one page.
   */
  const scrolling = mode === "scroll";
  const firstNumber = halves[0]?.pageNumber ?? null;
  const lastNumber = halves[halves.length - 1]?.pageNumber ?? null;

  const atFirst = scrolling
    ? currentPageNumber != null && currentPageNumber <= firstNumber
    : index === 0;
  const atLast = scrolling
    ? currentPageNumber != null && currentPageNumber >= lastNumber
    : index === views.length - 1;

  const stepBack = () => (scrolling ? scrollByPage("prev") : go("prev"));
  const stepForward = () => (scrolling ? scrollByPage("next") : go("next"));

  // The book names a frame ("Pages 3-4"); the column names one page.
  const counterLabel = scrolling
    ? `Page ${currentPageNumber ?? firstNumber ?? "-"}`
    : current.label;

  // Zoom opens the scan behind whatever is on screen. In the column that is the
  // scan the current page belongs to, which for a spread is the same scan for
  // both of its pages.
  const zoomTarget = scrolling
    ? (halves.find((half) => half.pageNumber === currentPageNumber)?.page ??
      current.pages[0])
    : current.pages[0];

  return (
    <div className="viewer">
      {renderToolbar && <div className="viewer__toolbar">{renderToolbar(current)}</div>}

      {scrolling ? (
        /*
         * One page per item, in a container with its own scrollbar rather than
         * the window's -- so the controls and the search box below stay put
         * instead of scrolling away from the reader who is using them.
         *
         * An ordered list because that is what this is: the pages of a book in
         * sequence. data-page-number is what the observer reads, and the inline
         * aspect-ratio is what lets every item reserve its true height before a
         * single byte of image arrives -- which is why the scrollbar is the
         * right length immediately instead of growing as scans land.
         */
        <ol className="column" ref={columnRef}>
          {halves.map((half) => (
            <li
              key={`${half.page.contentId}-${half.clip ?? "whole"}`}
              className="column__item"
              data-page-number={half.pageNumber}
              style={{
                aspectRatio: half.clip
                  ? half.page.width / 2 / half.page.height
                  : half.page.width / half.page.height,
              }}
            >
              <ZoomableSlot
                className="column__page"
                half={half}
                onOpen={setZoomed}
                busy={false}
                lazy
              />
            </li>
          ))}
        </ol>
      ) : (
      <div className="book">
        {/* Only the static slots open the zoom. The turning leaf renders these
            same halves onto its faces during a flip, so a click target there
            would ride the animation. */}
        <ZoomableSlot
          className="slot slot--left"
          half={leftHalf}
          onOpen={setZoomed}
          busy={!!flip}
        />
        <ZoomableSlot
          className="slot slot--right"
          half={rightHalf}
          onOpen={setZoomed}
          busy={!!flip}
        />

        {flip && (
          <div
            ref={leafRef}
            className="leaf"
            style={{
              transform: `rotateY(${leafAngle}deg)`,
              transition: atStart
                ? "none"
                : `transform ${FLIP_MS}ms cubic-bezier(0.33, 0, 0.2, 1)`,
            }}
            onTransitionEnd={(event) => {
              if (event.propertyName === "transform") settle();
            }}
          >
            <div className="leaf__face leaf__face--front">
              <Half half={leafFront} />
            </div>
            <div className="leaf__face leaf__face--back">
              <Half half={leafBack} />
            </div>
          </div>
        )}

        <div className="spine" aria-hidden="true" />
      </div>
      )}

      {/* The transcribed opening of whatever is on screen, set in the hand it
          was written in.

          This is the only surface that shows first_line as prose rather than as
          a row in a list. The other four -- this viewer's filter, /search, the
          admin index, the reorder list -- are all things you scan quickly for a
          match, and a script face measurably slows that down. So the hand goes
          here and nowhere else. */}
      {current.pages.some((page) => page.firstLine) && (
        <p className="viewer__line">
          {current.pages
            .filter((page) => page.firstLine)
            .map((page) => page.firstLine)
            .join(" · ")}
        </p>
      )}

      <nav className="controls">
        <button type="button" onClick={stepBack} disabled={atFirst || !!flip}>
          &larr; Previous
        </button>
        {/* Counter and jump field are one flex child, so .controls keeps its
            three columns and Previous/Next stay pinned to the edges. */}
        <div className="controls__center">
          <span className="counter" aria-live="polite">
            {counterLabel} <span className="counter__total">of {totalPages}</span>
          </span>

          {/* noValidate, with min/max kept for the spinner and screen readers:
              otherwise the browser blocks submit on an out-of-range number and
              onJump never runs, so the message below could only ever report a
              gap. One rule, one place, one wording. */}
          <form className="jump" onSubmit={onJump} noValidate>
            <label className="jump__label" htmlFor={jumpId}>
              Go to page
            </label>
            <input
              id={jumpId}
              className="jump__input"
              type="number"
              min="1"
              max={totalPages}
              inputMode="numeric"
              value={jumpValue}
              placeholder={String(current.pages[0].pageId)}
              onChange={(event) => {
                setJumpValue(event.target.value);
                setJumpError("");
              }}
            />
            <button type="submit" disabled={!!flip}>
              Go
            </button>
          </form>

          {/* Always rendered so it is an established live region; hidden by
              .jump__msg:empty until there is something to announce. */}
          <p className="jump__msg" role="status">
            {jumpError}
          </p>
        </div>

        {/* aria-pressed rather than a label that only changes visually, the same
            way the password reveal on the login form reports its state. */}
        <button
          type="button"
          className="controls__mode"
          onClick={toggleMode}
          aria-pressed={scrolling}
          disabled={!!flip}
          title={scrolling ? "Read as a book, two pages a time" : "Scroll one page at a time"}
        >
          {scrolling ? "Book view" : "Scroll view"}
        </button>

        <button
          type="button"
          className="controls__zoom"
          onClick={() => setZoomed(zoomTarget)}
          disabled={!!flip}
        >
          Zoom
        </button>

        <button type="button" onClick={stepForward} disabled={atLast || !!flip}>
          Next &rarr;
        </button>
      </nav>

      {/* Filters the pages already in memory -- no request, so results appear as
          you type and you never leave the page you are reading. */}
      <section className="search">
        <label className="search__label" htmlFor={searchId}>
          Search first lines
        </label>
        <input
          id={searchId}
          className="search__input"
          type="search"
          value={query}
          placeholder="a word from the first line&hellip;"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />

        {query.trim() !== "" && (
          <div className="search__results" role="status">
            {matches.length === 0 ? (
              <p className="search__empty">
                Nothing matches. Only pages with a first line typed in can be found.
              </p>
            ) : (
              <>
                <ul className="search__list">
                  {matches.slice(0, MAX_RESULTS).map((page) => {
                    const target = viewIndexForPage(views, page.pageId);
                    const span =
                      page.pageCount === 1
                        ? `page ${page.pageId}`
                        : `pages ${page.pageId}–${page.pageId + page.pageCount - 1}`;
                    return (
                      <li key={page.contentId}>
                        <button
                          type="button"
                          className="search__hit"
                          disabled={!!flip || (!scrolling && target === index)}
                          onClick={() => goToPage(page.pageId)}
                        >
                          <span className="search__span">{span}</span>
                          <HighlightedLine text={page.firstLine} query={query} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {matches.length > MAX_RESULTS && (
                  <p className="search__more">
                    and {matches.length - MAX_RESULTS} more
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {zoomed && (
        <PageZoom
          page={zoomed}
          label={
            zoomed.pageCount === 1
              ? `Page ${zoomed.pageId}`
              : `Pages ${zoomed.pageId}–${zoomed.pageId + zoomed.pageCount - 1}`
          }
          onClose={() => setZoomed(null)}
        />
      )}

      {/* Only the immediate neighbours are fetched ahead, so a flip never stalls
          while the rest of the diary stays unrequested. */}
      <div className="preload" aria-hidden="true">
        {neighbours.flatMap((view) =>
          view.pages.map((page) => (
            <img key={page.contentId} src={page.src} alt="" decoding="async" />
          ))
        )}
      </div>
    </div>
  );
}
