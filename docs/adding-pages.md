# Adding pages

Three ways in — the browser uploader, the terminal script, and text
recognition — plus what a scan is once it has been stored. See
[operating.md](operating.md) for the Supabase side and
[design.md](design.md) for the page model.

## Adding pages from the app

**Admin → Upload**, or the Upload link in the banner. Takes one image, or a PDF
whose pages each become a diary page in order. Two steps, the same shape as the
script below: **Analyse** shows what the pages would be, **Add** writes them.

The middle step is not ceremony. `page_count` fixes the numbering of every page
added after it, and nothing in the app can change it once written — so the
single/spread guess is a dropdown you can correct first, and the page numbers
update as you do.

Both steps run `analyse()` from `src/lib/ingest.js`, which is the same function
the script uses. There is deliberately no second pipeline.

### What it stores

Pages are JPEG at up to 2400px wide, because these are photographs of paper —
the content PNG compresses worst. The 14 scans here average 150 KB, so the 1 GB
free tier holds roughly 6,800 pages; as PNG the same images would be ~13× larger
in both storage and egress. Nothing compounds the loss: `originals/` keeps the
pristine upload, so a later crop or rotation re-encodes once from that.

The file you pick is also written into `images/` as the full-resolution master,
and the manifest is regenerated, so `DIARY_SOURCE=local` keeps working. A PDF
contributes one PNG master per page. If `images/` is not writable — a deployment
rather than your own machine — that step is skipped and the result says so.

### PDFs

Rasterised locally with `pdfjs-dist` and `@napi-rs/canvas`. Nothing is sent to
Adobe or any other service: the diary only ever reaches your own Supabase.
(Adobe's PDF Services free tier is real — 500 document transactions a month —
but it would mean uploading private pages to a third party, needing credentials,
and depending on their uptime.)

Each page is rendered so its long edge lands near 2400px, computed per page
rather than at a fixed DPI, to PNG first — lossless, so `analyse()` still does
exactly one lossy encode. Limits: 100 MB per upload, 200 pages per PDF.

Two things worth knowing if you touch this code:

- The file is sent as the **raw request body**, not multipart. `request.formData()`
  refuses bodies over about 10 MB, which most scanned PDFs are.
- pdfjs wants `standardFontDataUrl` as a path with forward slashes and a
  trailing one. A `file://` URL breaks on any project folder with a space in its
  name — this one has two.

## Adding pages from the terminal

Drop scans into `images/incoming/`, then:

```bash
npm run add
```

That prints the plan and changes nothing. Check the **single/spread** column —
it decides the page numbering for everything added after it, and it is the one
value that is awkward to correct later. Then:

```bash
npm run add -- --commit
```

Each scan is uploaded, its row inserted, and the original moved into `images/`
alongside the rest. The emptied `incoming/` folder is the record of what has
been added, so re-running is safe.

Everything else is derived from the file: page numbers continue from the end of
the diary, dimensions are measured, EXIF rotation is baked in, and anything
wider than 2400px is downscaled. Order comes from a numeric-aware filename sort,
so `_10` lands after `_2` rather than before it.

If a scan is guessed wrong — an open spread that happens to be portrait, say —
override it:

```bash
npm run add -- --commit --single=odd-one.jpg
```

`first_line` stays empty; fill it in from `/admin/pages`.

The script also regenerates `src/lib/manifest.generated.json`, which is what
`DIARY_SOURCE=local` reads. That file is gitignored like `images/` itself —
both only exist on the machine holding the scans, so a fresh clone has neither.
Never edit it by hand.

## Filling in `first_line`

`first_line` is what search reads. Type it in from **Admin → Page index**, which
reports how many scans have one and can filter to the blank ones
(`/admin/pages?blank=1`) so the gaps can be worked through.

A spread row covers two pages, so use the first line of the **left** page and
stay consistent. Nothing depends on the column being filled, so it can be done
gradually — but a scan with no first line cannot be found by search.

## Recognising text

Search only ever matched a **typed** first line, so of 49 scans exactly 2 could
be found. `npm run ocr` is the supply side of that: it reads each scan and
stores the text, which search then matches with the same rule as everything
else.

```bash
npm run ocr -- --diary=5                  # what it would do, writes nothing
npm run ocr -- --diary=5 --commit         # recognise with Tesseract and save
npm run ocr -- --diary=1 --export=<dir>   # write the scans out to transcribe elsewhere
npm run ocr -- --diary=1 --import=<file>  # save transcriptions made elsewhere
```

Preview by default and `--commit` to act, the same shape as `npm run add`.
`--force` redoes pages that already have text.

### Two engines, because handwriting is a different problem

**Tesseract**, via `tesseract.js`, is local, free and private, and it is genuinely
good at clean print: on a typeset page here it returns the text exactly, at 95%
confidence. It is close to useless on cursive — and so are the cloud OCR
services, which published comparisons put at roughly 45–63% on cursive
narrative. A handwritten volume needs a vision model.

`--export` / `--import` is that second route without this repository needing an
API key or a new dependency: it writes the scans and a manifest to a directory,
something that can read handwriting transcribes them, and the text comes back as

```json
{ "diaryId": 1, "pages": [{ "pageId": 1, "text": "..." }] }
```

The manifest means a transcriber only ever deals in page numbers; storage keys
stay on the server. Importing a file whose `diaryId` does not match is refused,
because every volume numbers its pages from 1 and the mistake would otherwise be
silent.

`tesseract.js` is a **devDependency**: only `scripts/` imports it, so it never
reaches the deployed function bundle.

### It reads the published scan, never the original

`originals/` holds the scan as it was *before* redaction. Recognising from there
would produce text containing exactly the words the censor bars exist to hide,
and then make them searchable — a leak dressed up as a feature. The script reads
`storage_key`, the published copy with the bars burned in, which is also the only
object `/api/scan` will ever sign.

Tested rather than assumed: a page whose scan carries a bar over a name
recognises as `was Captain Wii`, and searching that name returns nothing.

### Corrections are permanent

Recognised text is editable per scan in **Admin → Page index**, behind a
disclosure so dozens of pages of text do not bury the first lines. Saving marks
the row `manual`, and the script skips anything marked `manual` **even with
`--force`** — so correcting a page is permanent and re-running over a volume is
always safe.

A missing `first_line` is filled in from the recognised text; one that is
already there is never overwritten, because a typed line is a person's summary
of the page and outranks the top line of whatever an engine read.

### Where the text lives, and why not on `pages`

`page_text` is its own table keyed on **`storage_key`**, for two reasons that
are both about not breaking something that already works:

- `readSupabasePages()` reads with `select("*")` on purpose, so a column on
  `pages` would be loaded on every render of every page of the reader, forever,
  for text the reader never shows. A separate table is simply never touched by
  that query — and nothing in the reader's module graph imports
  `src/lib/page-text.js`, which is what keeps it that way.
- `page_id` is rewritten wholesale by a reorder. Text keyed on the number would
  silently reattach to the wrong scans the first time a volume was reordered;
  `storage_key` is the identity that survives, as the reorder migration says.

It is cheap. All 49 scans come to roughly 150 kB of text — about the size of one
scan image — against a 500 MB free-tier database currently holding 11 MB.

## The scans

Scans live in `images/` and are **gitignored** — diary content never enters git
history. Keep them as your master copy; the upload script only reads them.

Two things about these files are easy to get wrong:

- **They carry EXIF orientation 6 or 8**, so their stored JPEG dimensions are
  portrait while they *display* landscape. Browsers rotate automatically, but
  `sharp` does not unless you call `.rotate()`. The upload script bakes the
  rotation into the uploaded bytes so nothing downstream has to care.
- **Filenames are not a reliable sort key.** Both batches end in digits, so
  sorting on the trailing number alone interleaves them, and a lexicographic
  sort puts `_10` before `_2`. Order comes from the explicit `page_id`.

