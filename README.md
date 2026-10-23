# Bookshelf

Live at **<https://diary-website-khaki.vercel.app>**. `Quar Rules` is open to
anyone; the handwritten volume is not — that is the visibility system below
doing its job, not a broken link.

A shelf of scanned volumes, read as books — a real page-turn, two pages to a
spread — with the tools to run the archive behind it: upload scans or whole
PDFs, rotate and crop them, black out what should stay private, reorder pages,
and search what has been transcribed.

It started as one handwritten diary, which is still the volume it was built
around. That is also why every volume carries a **visibility**: a notebook can
be open to anyone, to signed-in readers, or to nobody but an admin.

Next.js (App Router), plain JavaScript, Supabase for page rows, private image
storage and auth. No test framework, no ORM, no UI library.

**The scans are private and stay out of git.** This repository is the code
only: images, the generated manifest and every credential are gitignored, and
no commit in the history has ever contained a scan or a transcription.

## The problem it actually solves

A scan is not a page. A photograph of an open notebook is *two* pages, and the
next photograph might be one. That single fact drives most of the design:

- **Page numbers are derived, not stored identity.** A scan occupies
  `page_count` consecutive numbers, so the diary is an ordered list of scans and
  the numbering falls out of it. Reordering is therefore a renumbering of
  everything, done in one SQL function so it cannot half-apply; deleting a page
  closes its gap the same way. A UI keyed on page numbers silently showed the
  wrong images, which is why every list is keyed on a content-derived id
  instead.
- **Redaction is data, not a burn.** Censor bars are stored as percentages of
  the *original* image and re-applied by the publish pipeline —
  `crop(rotate(bars(original)))`. Burning them into the published bytes would
  mean the next crop silently republished the uncensored scan. The pristine
  original is kept so an admin can still see what a bar covers, behind the one
  endpoint that requires an admin.
- **The database is closed by default.** RLS is on with **no policies**, which
  denies every anon and authenticated request; the app reads through the server
  with the secret key. Supabase hands the publishable key to browsers by design,
  so anything less would publish the diary index.

## Architecture

```
browser ──► Next.js server ──► Supabase Postgres   page rows, RLS-closed
                │
                └────────────► Supabase Storage    private bucket, signed URLs

/api/scan/<pageId>          the only image path a reader can reach
/api/admin/original/<id>    pristine, pre-redaction, admin-only
```

`src/lib/pages.js` is the seam: everything above it asks for pages, everything
below it decides whether they come from Postgres or from disk. Pure rules live
beside it — `views.js` (grouping scans into spreads), `ordering.js`
(renumbering), `search.js` (matching), `redaction.js` (box geometry) — with no
database or React imports, which is what makes them directly testable.

## Running it

Requires Node 22+ (developed on 26.4.0).

```bash
npm install
npm run dev
```

Then open http://localhost:3000. Arrow keys or the buttons turn pages.

Other commands:

- `npm test` — the suite (no database or scans needed; fixtures are generated)
- `npm run lint`
- `npm run build` — production build
- `npm start` — serve the production build (run `build` first)
- `npm run add` — preview adding new scans
- `npm run add -- --commit` — add them
- `npm run ocr -- --diary=N` — recognise the text on a volume's scans

## Tests

`node --test`, no framework. 235 tests across 36 suites covering the
rules that are easy to get quietly wrong: dense renumbering, view grouping,
accent-insensitive matching, EXIF orientation, PDF page order, redaction
geometry and upload path safety.

Every fixture is **generated at run time** — images via sharp, including one
carrying EXIF orientation 6, and a hand-built three-page PDF whose ink rises per
page so ordering can be checked without reading text back. Nothing reads
`images/`, so the suite passes on a machine that has never seen the diary. CI
runs it on Node 22 and 24 with no credentials at all.


## Documentation

The detail lives in `docs/`, so this page stays readable:

- **[Operating an instance](docs/operating.md)** — deploying to Vercel, the
  three environment variables, first-time Supabase setup, what happens when a
  free project pauses, the two keep-alives, and running the whole stack locally.
- **[Adding pages](docs/adding-pages.md)** — the browser uploader and its two
  body limits, the terminal script, PDFs, and recognising the text on a scan.
- **[Design notes](docs/design.md)** — roles and visibility, how access is
  enforced, the page model, search, and the layout.

## Licence

MIT, in [LICENSE](LICENSE). It covers the code, which is all this repository
holds. The scans and their transcriptions are not here and are not licensed by
it — they live in a private Supabase project and stay there.
