"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Upload a scan or a whole PDF, in two steps.
 *
 * Analyse first, commit second -- the same shape as `npm run add` then
 * `--commit`. The middle step is not ceremony: page_count decides the numbering
 * of every page added after it and nothing in the app can change it later, so
 * the guess has to be correctable before it is written. For a forty page PDF
 * that is the difference between a minute of checking and re-adding the lot.
 */
/**
 * One decimal place of megabytes.
 *
 * Deliberately not imported from lib/uploads.js, which owns the server-side
 * copy: that module reaches for node:fs and would not survive the trip into a
 * client bundle. The limit itself is passed down rather than recomputed, so the
 * number that matters cannot drift.
 */
const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/** "as page 27" for one page, "as pages 27–31" for a range. */
function commitLabel(items) {
  const first = items[0]?.start;
  const last = items.at(-1)?.end;
  const span = first === last ? `page ${first}` : `pages ${first}–${last}`;
  return `Add ${items.length} scan${items.length === 1 ? "" : "s"} as ${span}`;
}

export default function UploadForm({ lastPage, diaryId, diarySlug, maxBytes }) {
  const router = useRouter();
  const fileRef = useRef(null);

  const [plan, setPlan] = useState(null);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  /**
   * Forget the previous plan, keeping whatever is in the picker.
   *
   * Bound to the file input's change event, so it must NOT touch the input's
   * value: clearing it there would wipe the file the moment it was chosen.
   */
  function clearOutputs() {
    setPlan(null);
    setCounts({});
    setError(null);
    setResult(null);
  }

  /** Forget the plan and empty the picker too -- Cancel, and after a commit. */
  function reset() {
    clearOutputs();
    if (fileRef.current) fileRef.current.value = "";
  }

  async function analyse(event) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first.");
      return;
    }

    /*
     * Refused here, before a single byte goes up.
     *
     * The route checks this too and is the authority, but on a host with a
     * small ceiling the platform rejects the request itself -- after the whole
     * file has been transferred, with a body we do not control. So the admin
     * would watch a 40 MB upload complete and then be told nothing useful. The
     * ceiling arrives as a prop because it is a property of the server this
     * page was rendered by, not a constant.
     */
    if (maxBytes && file.size > maxBytes) {
      setError(
        `That file is ${megabytes(file.size)} MB. This server accepts up to ` +
          `${megabytes(maxBytes)} MB.`
      );
      return;
    }

    setBusy("analysing");
    setError(null);
    setResult(null);

    try {
      // The file goes up as the raw body. Wrapping it in FormData would route it
      // through a parser that rejects anything over about 10 MB, which most
      // scanned PDFs are.
      const response = await fetch("/api/admin/upload/plan", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-upload-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await response.json();
      if (!data.ok) {
        setError(data.message ?? "That did not work.");
        return;
      }
      setPlan(data);
      setCounts(Object.fromEntries(data.items.map((item) => [item.index, item.pageCount])));
    } catch (fetchError) {
      setError(`Upload failed: ${fetchError.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    setBusy("adding");
    setError(null);

    try {
      const response = await fetch("/api/admin/upload/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          diaryId,
          stagingId: plan.stagingId,
          items: plan.items.map((item) => ({
            index: item.index,
            pageCount: counts[item.index] ?? item.pageCount,
          })),
        }),
      });
      const data = await response.json();
      if (!data.ok) {
        setError(data.message ?? "That did not work.");

        // Some pages may still have landed. The server has already trimmed
        // those out of the staged plan, so mirror that here: pressing Add again
        // must retry only what is left, not re-add what succeeded.
        if (Array.isArray(data.remaining)) {
          setPlan((current) => (current ? { ...current, items: data.remaining } : current));
          setCounts((current) =>
            Object.fromEntries(
              data.remaining.map((item) => [item.index, current[item.index] ?? item.pageCount])
            )
          );
        }
        if (data.added?.length) router.refresh();
        return;
      }
      setResult(data);
      setPlan(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (fetchError) {
      setError(`Commit failed: ${fetchError.message}`);
    } finally {
      setBusy(null);
    }
  }

  // Page numbers are provisional: they are worked out again on the server at
  // commit, against the database as it is then. Shown so the effect of a
  // single/spread change is visible before committing.
  // reduce rather than a counter mutated inside map: the running total is
  // carried in the accumulator instead of a variable the callback closes over,
  // which is the same result without a render-time reassignment.
  const numbered = (plan?.items ?? []).reduce((rows, item) => {
    const pageCount = counts[item.index] ?? item.pageCount;
    const start = (rows.at(-1)?.end ?? lastPage) + 1;
    return [...rows, { ...item, pageCount, start, end: start + pageCount - 1 }];
  }, []);

  return (
    <div className="upload">
      <form className="upload__pick" onSubmit={analyse}>
        <label className="upload__label" htmlFor="upload-file">
          Image or PDF
        </label>
        <input
          id="upload-file"
          ref={fileRef}
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.pdf"
          onChange={clearOutputs}
          disabled={!!busy}
        />
        <button type="submit" disabled={!!busy}>
          {busy === "analysing" ? "Reading…" : "Analyse"}
        </button>
        {plan && (
          <button type="button" onClick={reset} disabled={!!busy}>
            Cancel
          </button>
        )}
      </form>

      {busy === "analysing" && (
        <p className="admin__note" role="status">
          Reading the file. A long PDF takes a moment — every page is rendered.
        </p>
      )}

      {error && (
        <p className="actionform__error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="upload__done" role="status">
          <p className="actionform__ok">{result.message}</p>
          <p className="admin__note">
            {result.mastersSaved > 0
              ? `${result.mastersSaved} master file(s) copied into images/.`
              : "Masters were not copied — images/ is not writable from here."}{" "}
            Add first lines from the <Link href={`/admin/d/${diarySlug}/pages`}>page index</Link>, or{" "}
            <Link href={`/d/${diarySlug}?page=${result.added[0]?.pageId}`}>open the first new page</Link>.
          </p>
        </div>
      )}

      {plan && (
        <>
          <p className="admin__note">
            {plan.isPdf
              ? `${plan.items.length} page(s) from ${plan.source}, in order.`
              : plan.source}{" "}
            Nothing has been written yet. Check the single/spread column — it sets
            the numbering for everything after it, and cannot be changed once added.
          </p>

          <ul className="upload__list">
            {numbered.map((item) => (
              <li key={item.index} className="upload__row">
                <img className="order__thumb" src={item.thumbnail} alt="" />

                <div className="upload__meta">
                  <span className="order__span">
                    {item.start === item.end
                      ? `page ${item.start}`
                      : `pages ${item.start}–${item.end}`}
                  </span>
                  <span className="upload__file">{item.label}</span>
                  <span className="upload__dims">
                    {item.width}×{item.height} · {(item.byteSize / 1024).toFixed(0)} KB
                  </span>
                </div>

                <label className="upload__count">
                  <span className="visually-hidden">Pages covered by {item.label}</span>
                  <select
                    value={item.pageCount}
                    disabled={!!busy}
                    onChange={(event) =>
                      setCounts((current) => ({
                        ...current,
                        [item.index]: Number(event.target.value),
                      }))
                    }
                  >
                    <option value={1}>single</option>
                    <option value={2}>spread</option>
                  </select>
                  {item.pageCount !== item.guessed && (
                    <span className="upload__changed">changed</span>
                  )}
                </label>
              </li>
            ))}
          </ul>

          <div className="upload__commit">
            <button type="button" onClick={commit} disabled={!!busy}>
              {busy === "adding" ? "Adding…" : commitLabel(numbered)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
