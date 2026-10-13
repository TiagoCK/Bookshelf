# Bookshelf

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

## Tests

`node --test`, no framework. 110 assertions across six suites covering the
rules that are easy to get quietly wrong: dense renumbering, view grouping,
accent-insensitive matching, EXIF orientation, PDF page order, redaction
geometry and upload path safety.

Every fixture is **generated at run time** — images via sharp, including one
carrying EXIF orientation 6, and a hand-built three-page PDF whose ink rises per
page so ordering can be checked without reading text back. Nothing reads
`images/`, so the suite passes on a machine that has never seen the diary. CI
runs it on Node 22 and 24 with no credentials at all.

## Deploying

Hosted on Vercel's free Hobby tier. **GitHub Pages cannot host this** — every
route is `force-dynamic` and needs a server for Supabase auth, for minting
signed Storage URLs and for `src/proxy.js`. A static export would be an empty
shell.

Import the repository at [vercel.com](https://vercel.com). The Next.js preset is
detected and no `vercel.json` is needed: functions default to the `iad1` region,
which is already where the Supabase project lives.

`.vercelignore` keeps `images/`, the generated manifest and `supabase/.temp/`
out of an upload. A Git-based deploy never sees them — they are gitignored — but
`vercel` run from the project root uploads the working tree, and that would put
the scans themselves on a CDN.

Three environment variables, in Production and Preview:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` |
| `SUPABASE_SECRET_KEY` | `sb_secret_...`, server only |

**Do not set `SUPABASE_URL`.** `getSupabase()` falls back to the public one, and
setting both is the only way to trip the mismatch guard in
`assertPublicUrlMatches()`. **Do not set `DIARY_SOURCE`** — it defaults to
`supabase`, and `local` would look for scans a deployment does not have.

Nothing needs changing in Supabase. Sign-in is `signInWithPassword`, not OAuth
or a magic link, so no redirect-URL allowlist is tied to the hostname.

Set the project's Node version to 24 LTS; `engines` asks for 22+ and nothing
here needs newer.

### What the free tier costs

Almost nothing, for one reason: `/api/scan` answers `302` with a signed Supabase
URL, so **scan bytes never pass through Vercel**. The 100 GB monthly transfer
allowance goes on HTML, CSS and JS. Nothing uses `next/image` either, so the
5,000 monthly image transformations are irrelevant.

What does apply:

- Hobby is **non-commercial personal use only**. Donations are explicitly fine;
  advertising, affiliate links as the point of the site, or being paid to host
  it are not.
- Request *and response* bodies cap at **4.5 MB**, which is what sets the
  upload ceiling below.
- Cron jobs run at most **once a day** on Hobby, fired anywhere inside the
  scheduled hour. Not used here: the keep-alive already runs from GitHub Actions
  and from launchd.
- A Hobby project cannot be connected to a repository owned by a GitHub
  **organisation**. A personal repository is fine.

### Uploading from the deployment

Uploads work there, with a smaller ceiling. `src/lib/uploads.js` answers how
large a request this host accepts, and the routes, the form and the upload page
all read it:

| | Ceiling | How it is detected |
|---|---|---|
| A laptop | `MAX_UPLOAD_BYTES`, 100 MB | the working directory is writable |
| A deployment | `PLATFORM_MAX_UPLOAD_BYTES`, 4 MB | it is not |

4 MB rather than the 4.5 MB Vercel documents, so the refusal comes from us with
somewhere to go, instead of as an opaque `413 FUNCTION_PAYLOAD_TOO_LARGE` after
the whole file has been transferred. `UploadForm` checks the size before sending
a byte, for the same reason.

The test is whether the tree is writable rather than which platform this is, so
any read-only host gets the smaller ceiling with nothing configured.
`DIARY_UPLOADS=off` refuses outright and is the only value read; there is
deliberately no `on`, because the ceiling is a property of the host and a flag
claiming to lift it would only move the failure to the platform.

Two things a deployment cannot promise, both stated on the upload page rather
than left to be discovered:

- **No full-resolution master.** `saveMasters()` writes into `images/`, which a
  deployment does not have. Note this is equally true of a clone without an
  `images/` directory — `saveMasters()` returns 0 rather than throwing — so a
  deployment loses nothing that a laptop without that directory was keeping.
- **Staging may not survive.** The plan step leaves derived JPEGs in
  `os.tmpdir()` for the commit step. Fluid compute shares one instance across
  invocations so this usually holds; when it does not, the commit route answers
  `410 That upload has expired. Choose the file again.` A retry, not a loss.

What does **not** change is permanence. A commit writes rows to Postgres and
objects to Storage in the same Supabase project the local app uses, so a page
added from the deployment is live for everyone immediately. Nothing about it is
a preview, and the upload page says so — because the natural assumption is the
opposite.

## Signing in

Only to read what is not `public`. A volume marked public needs no account and
no session, which is the point of it; everything else does.

Accounts are invite-only and exist **only** when you create them in Supabase →
Authentication → Users, where you also set the password. The app has no sign-up
form, no "create account" link, and no `signUp()` call anywhere — a public
volume is read with no identity at all rather than with a throwaway one, so
there is nothing for a visitor to create.

**One dashboard setting is load-bearing:** Authentication → Sign In / Providers
→ Email → **"Allow new users to sign up" must be OFF**. The publishable key
ships to every browser, so while that toggle is on, anyone holding it can call
`signUp()` and create an account no matter what the UI offers.

No email is ever sent — no confirmations, no password resets — which keeps
Supabase's rate-limited built-in SMTP out of the picture entirely. If you forget
a password, reset it in the dashboard.

### Who can open a volume

Separate from roles, and checked separately. A role says what someone *is*; a
volume's `visibility` says who it is *for*:

| `visibility` | Who can open it |
|---|---|
| `public` | Anyone at all, with no account and no session |
| `readers` (default) | Anyone signed in |
| `admins` | Admins only — invisible on the shelf, and its images are refused |

Set it when adding a volume, or change it any time from **Admin → the volume's
"Who can open it"**. The default is `readers`, deliberately: nothing becomes
world-readable because a form field went untouched.

One rule decides all of it — `canSee()` in `src/lib/diary-rules.js` — because it
is consulted from five places (the shelf, the reader, search, the admin list and
the image route) and a copy of it that drifted would be a hole rather than an
inconsistency. It is the most heavily tested function here: the whole grid of
three visibilities against an anonymous, reader and admin viewer.

`public` is **not** a database grant. RLS stays on with no policies and the
server still reads with the secret key, filtering itself; a browser holding the
publishable key sees nothing directly, exactly as before. What changed is which
requests the server is willing to answer, not what the database will hand out.

A refusal is a **404, not a 403**. Telling someone a volume exists but is not
theirs is itself a disclosure.

### Roles

Every user has a row in `profiles` with a role, created automatically by a
trigger when you add them:

| Role | Can |
|---|---|
| `reader` (default) | Read the diary |
| `admin` | Read the diary, plus `/admin` to edit each page's `first_line` |

Promote someone from `/admin` → People, which lists every account from
Authentication → Users and lets you set a role even before their first sign-in.
You can also edit the `role` cell directly in Table Editor → `profiles`.

Note there is **no database trigger** creating profile rows. Supabase restricts
DDL on the `auth` schema, so `create trigger ... on auth.users` fails. Instead
the app creates a user's profile the first time it sees them
(`ensureProfile()` in `src/lib/auth.js`), defaulting to `reader`, and the admin
page can assign a role ahead of that.

An admin cannot change their own role — with a single admin that would lock the
role out of the app permanently, since nothing else can grant it.

### How access is enforced

Every read goes through the Next.js server using the secret key, so the
**server** is the security boundary, not RLS. RLS is still on (with no policies)
for both `pages` and `profiles`, which is what makes it safe for the browser to
hold a Supabase client for the login form — the publishable key can't read a row.

Three things in the code are deliberate and easy to undo by accident:

- **`getUser()`, never `getSession()`, on the server.** `getSession()` decodes
  the cookie and trusts it; `getUser()` revalidates against the auth server.
- **`src/proxy.js` is not the security boundary.** It refreshes sessions and
  redirects politely. Every protected surface re-checks for itself —
  `src/app/page.js`, `src/app/admin/page.js`, the server action in
  `src/app/admin/actions.js` (server actions are publicly reachable endpoints,
  so guarding the form's page guards nothing), and above all
  `src/app/api/scan/[diaryId]/[pageId]/route.js`, which serves the images.

  That matters more since public volumes arrived: the proxy now lets anonymous
  requests through rather than bouncing them to `/login`, so what used to be a
  belt-and-braces re-check is the only check.
- **A signed-out visitor and an unreachable project look identical to the auth
  call.** With no session cookie, supabase-js answers `getUser()` with
  `AuthSessionMissingError` and never touches the network — so an outage is
  invisible until the first data read. `orPaused()` in `src/lib/auth.js` is what
  turns that read's failure into the paused page instead of a 500.


## Where the pages come from

`DIARY_SOURCE` in `.env.local` selects the backing store:

| Value | Page data | Images |
|---|---|---|
| `supabase` (default) | `pages` table | private Supabase Storage, via signed URLs |
| `local` | the manifest in `src/lib/pages.js` | `images/` on disk |

The switch is explicit rather than an automatic fallback. A Supabase free-tier
project pauses after about a week of inactivity, and silently serving stale
local data in that case would be more confusing than a loud failure. Set
`DIARY_SOURCE=local` to work offline or while the project is paused.

## First-time Supabase setup

1. **Apply the migrations** with the CLI, not by pasting SQL:

   ```bash
   brew install supabase/tap/supabase
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   `db push` applies only what the remote has not seen and records each one in
   its history table, so "which migrations have run?" stops being a question you
   answer by reading git log. It needs no container runtime — only the local
   stack does.
2. **Set the keys** in `.env.local`. All four, from Project Settings → API:

   | Variable | Used by |
   |---|---|
   | `SUPABASE_URL` | the server, for every data read |
   | `SUPABASE_SECRET_KEY` | the server. `sb_secret_...`, bypasses RLS; never prefix it `NEXT_PUBLIC_` |
   | `NEXT_PUBLIC_SUPABASE_URL` | the browser, to sign in. Must equal `SUPABASE_URL` |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the browser and the middleware, to sign in. `sb_publishable_...` |

   Without the publishable key there is no sign-in at all, and since every page
   is behind auth, nothing loads past the login form — `@supabase/ssr` throws on
   a missing key rather than degrading, so the middleware fails on every
   request.

   These are the **new** API keys. They replace the legacy `anon` and
   `service_role` keys, which Supabase is deprecating by the end of 2026:
   publishable for anything you ship, secret for anything you control. The
   privileges are identical to the pair they replace, so every argument below
   about RLS still holds unchanged — the publishable key maps to the Postgres
   `anon` role, which is what the policies in `supabase/migrations` name.

   Nothing here reads `SUPABASE_JWKS_URL`. Local JWT verification would skip the
   revocation check that `getUser()` performs, and `src/lib/auth.js` documents
   why it wants the checked one.
3. **Add the scans.** See below.

### Why row-level security matters here

Supabase exposes every table over PostgREST authenticated with the publishable
key, and that key is public by design — it ships to browsers. With RLS off,
anyone holding it can read the whole diary index.

The migration enables RLS and writes **no policies**, which denies all `anon` and
`authenticated` access while the secret key bypasses RLS entirely. Every read
therefore goes through the Next.js server, which holds the secret key. Don't add
a policy without deciding who it's for.

The `diary-scans` bucket is private for the same reason: objects are reachable
only through short-lived signed URLs minted server-side.

## When the project is paused

A free-plan project pauses after about a week without database activity, and
every surface — Postgres, auth, storage — then answers HTTP 540 at once.

The thing worth knowing is that this used to produce a **lie**. The middleware
asked Supabase who you were, an unreachable project answered "no user" plus an
error, the error was discarded, and you were redirected to the login page —
where any sign-in failure was reported as `That email and password combination
didn't work.` A paused project told its owner their password was wrong.

So `src/lib/outage.js` exists to make one distinction the code was not making:
**unreachable is not unauthorized.** `isOutage(error, status)` recognises a
transport failure or an availability status and, deliberately, nothing else — a
wrong password or an RLS refusal must never read as an outage, or it would tell
someone to wait for a problem that is never going to clear.

With that in place:

| Situation | What happens |
|---|---|
| Signed in, project paused | Redirected to `/paused`, which explains it |
| Not signed in, project paused | `/login`, which says it is unavailable and that your password is not the problem |
| `/api/scan/...` during a pause | **503** with `Retry-After`, not 401 |
| A wrong password, project healthy | Unchanged: the password is blamed |

Two subtleties behind that table:

- **A cookie-less visitor still lands on `/login`.** With no session to check,
  supabase-js never makes a network call, so an outage is genuinely invisible at
  that point. The login form is where the truth surfaces.
- **Nothing can leak by letting those requests through.** Every byte of diary
  content comes from the project that is down, so pages cannot read rows and the
  scan route cannot mint a signed Storage URL. There is nothing to serve.

`/paused` deliberately names no provider and no restore procedure: during an
outage auth is down, so it cannot tell the owner from a stranger.

To work while a project is paused, or offline, set `DIARY_SOURCE=local`.

### Why the error has to carry a status

`isOutage()` takes the HTTP status separately because postgrest-js throws it
away. A paused project yields the error object `{ message: "Project is paused" }`
and nothing else, while the `540` sits on the *response* — so every data read
passes `status` alongside `error`. The auth client has the opposite problem: a
540 with a plain-text body becomes an `AuthUnknownError` whose message is a JSON
parse failure, with the status gone, which is why that name counts as an outage.
Both shapes are pinned in `tests/outage.test.mjs`, measured from the real client
rather than imagined — an earlier invented fixture passed while every real
paused-project case fell through.

## Keeping the project awake

Prevention, because **a ping cannot wake a paused project** — restoring one is a
manual click in the dashboard, and after 90 days paused even that is gone. A few
real database requests a day are enough to keep it from pausing.

`scripts/keepalive.sh` is the whole mechanism: one `curl` issuing one `select`
against `pages` with the **publishable key**, never the secret key. Two
schedulers run that one script, so there is no second implementation to drift.
It exits non-zero on anything but 200, and exits `2` for a 540 with a message
saying restoring is manual.

It sends the key on the `apikey` header only. Publishable and secret keys are
opaque strings, not JWTs, and Supabase documents them as belonging there alone —
`Authorization: Bearer` is accepted for migration compatibility and
authenticates nobody. Measured against the project: `apikey` alone 200,
`apikey` + `Bearer` 200, `Bearer` alone 401.

Run it by hand any time:

```bash
scripts/keepalive.sh
```

It reads `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the environment if they are
set, and otherwise `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` out of
`.env.local` — so this machine keeps exactly one copy of the credentials.

### GitHub Actions, every two days

`.github/workflows/keepalive.yml`. Add two repository secrets under Settings →
Secrets and variables → Actions: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. A
failed ping fails the job, which is how you hear about it.

**Known gap:** GitHub disables scheduled workflows after 60 days without a
commit to the repository — precisely the quiet stretch when this matters. It
emails first, and re-enabling is one click. The local agent covers that window.

### A launchd agent, daily

```bash
scripts/install-keepalive.sh
```

That is the whole install. It prints the paths it used and the result of a real
ping, and exits non-zero if that ping did not succeed — so a silent failure is
not a possible outcome. Re-run it any time; it is idempotent, and re-running is
also how you refresh the installed copy after editing `scripts/keepalive.sh`.

To remove it:

```bash
scripts/install-keepalive.sh --uninstall
```

Check on it:

```bash
tail ~/Library/Logs/diary-keepalive.log
launchctl print gui/$(id -u)/com.diarywebsite.keepalive
```

#### Why there is an installer and not a one-line `sed`

Two macOS privacy-protection (TCC) behaviours make the obvious install silently
useless, and both of them look like a different problem:

1. **A LaunchAgent cannot read anything under `~/Documents`.** It holds none of
   the privacy grants your Terminal has, so pointing the job straight at
   `scripts/keepalive.sh` in the repo fails with `Operation not permitted`
   before the script runs at all. The installer therefore copies the script to
   `~/Library/Application Support/diary-keepalive/`, which is not protected.
2. **It cannot read `.env.local` either — and `test -r` still returns true.**
   The stat succeeds and only the open is denied, so a naive script sees a file
   that appears present and comes back empty, then reports missing credentials.
   The installer writes the config into the plist's `EnvironmentVariables`
   instead, reading it from `.env.local` itself while running as you.

Only the **publishable** key is ever written into the plist. It is public by
design — Supabase ships it to browsers — so this is not a secret spreading, and
the installer refuses outright if handed an `sb_secret_` value. The alternative,
granting Full Disk Access to `/bin/sh`, would hand every shell script on the
machine access to everything, which is a far worse trade for a daily `curl`.

`scripts/keepalive.plist` in the repo is the template, carrying `__SCRIPT__`,
`__URL__`, `__KEY__` and `__HOME__` placeholders. Do not hand-install it. The
installer substitutes them with `plutil` rather than `sed`, so a key containing
a regex or shell metacharacter cannot corrupt the result.

Notes worth having:

- It is **shell and curl, not Node, deliberately.** launchd hands a job a
  minimal `PATH` that does not include nvm's node, and nvm's path carries the
  version number, so it would break on the next upgrade. `/usr/bin/curl` is
  always there, and the same script runs unchanged on CI.
- A failure raises a macOS notification, since a launchd job is otherwise
  silent. One HTTPS request a day: nothing resident, nothing measurable.
- The installed plist holds absolute paths and a copy of the script, so **after
  moving the repo, re-run the installer.**

## The local Supabase stack

Optional, and worth it for one specific reason: until now the migrations had
**never been replayed from scratch**, so nobody knew whether they applied
cleanly in order — and the two SQL functions that renumber
(`..._reorder.sql`) or delete (`..._delete_page.sql`) every page of a diary had
only ever run against the database holding the irreplaceable content.

```bash
supabase start          # Postgres, auth, storage, Studio on localhost
scripts/dev-local.sh    # the app, pointed at them
supabase stop           # when you are done
```

`supabase db reset` rebuilds the local database from zero. That is the command
that proves the schema, and it is how the missing `diary-scans` bucket was
found: nothing in this repository created it any more, so the project could not
be rebuilt from its own source. `..._scans_bucket.sql` now declares it.

`scripts/dev-local.sh` reads the local URL and keys from `supabase status` at
launch and exports them, which Next prefers over `.env.local`. So there is no
second credentials file to go stale, and `.env.local` is never touched — it
keeps pointing at the hosted project, as does `scripts/keepalive.sh`.

### What it costs

The cost is the stack, not Docker. Quit the runtime and the impact is disk only;
Docker Desktop idling with Resource Saver is close to nothing. What you feel is
`supabase start`, and Supabase suggests budgeting ~7 GB of RAM for the full set
of services.

So `supabase/config.toml` turns off the ones this project does not use, and the
saving is real — **eight containers instead of fourteen**:

| Service | Why it is off |
|---|---|
| `analytics` | Logflare plus a vector collector, the heaviest part by memory |
| `realtime` | Nothing here subscribes to changes — no `.channel()` anywhere in `src/` |
| `edge_runtime` | There is no `supabase/functions` directory |

`imgproxy`, `vector` and `pooler` fall away with them. Studio stays on, because
being able to look at the local database is most of the point; turn it off in
`config.toml` if you would rather have the memory back.

On macOS, **OrbStack** is lighter than Docker Desktop and is what Supabase now
recommends. Note that the Supabase CLI shells out to a `docker` binary rather
than talking to the socket, so the client has to be on `PATH`:

```bash
brew install --cask orbstack   # the engine
brew install docker            # just the client the CLI calls
```

Open OrbStack once so it finishes its own setup and puts a socket at the default
path; until then, export
`DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"` (which
`scripts/dev-local.sh` does for you).

### What it does not do

It does not containerise the app, and it should not. The app treats the host
filesystem as the master copy of irreplaceable data — it writes full-resolution
scans into `images/` and regenerates `src/lib/manifest.generated.json` — so a
container would add a path where the only copy of a scan lands in an ephemeral
layer. CI has no use for it either: the suite already runs on two Node versions
with no credentials at all.

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

## Search

Three surfaces, one rule. `src/lib/search.js` holds the matching, so they cannot
drift apart:

- **In the viewer** — filters the pages already in memory as you type; clicking
  a result turns to that page. No request.
- **`/search?q=`** — a plain GET form, so the URL is shareable and it works with
  JavaScript off. Results link to `/?page=N`, which opens the reader at that
  page.
- **Admin → Page index** — `?q=` over the same rule, plus coverage and the blank
  filter.

Terms are ANDed and matched as substrings, case- and accent-insensitively, so
`electrical student` finds *"electrical engi student"*. A blank query matches
nothing rather than everything.

`fold()` maps each character to exactly one folded character rather than running
`normalize("NFD")` over the whole string, because `highlight()` finds matches in
the folded text and slices the **original** at those offsets. NFD turns `é` into
two code points and would shift every offset after it, marking the wrong
letters.

Matching runs in the app, not in Postgres. `getPages()` already loads every
row's metadata on every render, so filtering 14 rows is free, and one rule beats
two that disagree — `ilike` folds case by its own collation and would not match
the filter running in the browser. **Past a few thousand scans**, move this to
`ilike` with a `pg_trgm` index and have the viewer's live filter call it.

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

## The page model

A **view** is one frame of the open book:

- A spread (`page_count: 2`) fills a view alone.
- Two consecutive single pages pair into one view, left and right.
- A trailing unpaired single sits on the left with a blank facing page.

So every view has a left half and a right half no matter what it is made of,
which is what lets the flip animation use one code path. `halfOf(view, side)`
returns either half of a spread (clipped) or a whole single page.

The current 14 scans yield 13 views covering pages 1–26.

The controls under the book carry a **Go to page** field. It takes any page
number and shows the view holding it, so an interior number resolves to its
frame — page 4 opens the spread at pages 3–4. That is deliberately unlike the
**Order** tab, which refuses an interior number: reordering has to know which
*scan* you mean, while reading only has to know which *frame*. Jumping to the
neighbouring view flips; anything further lands directly, since the leaf
animation turns exactly one view.

## Layout

```
src/app/          routes and UI (App Router)
  page.js         server component; fetches metadata, renders the viewer
  layout.js       root layout, page metadata
  globals.css     global styles, including the 3D book
  api/scan/       serves a page's image (see below)
src/components/
  BookViewer.js   client component; the page-flip and navigation
src/lib/
  pages.js        THE SEAM — page data, view assembly, image URLs
  outage.js       unreachable vs unauthorized (see When the project is paused)
  fonts.js        which font files load (see Typography)
  supabase.js     server-only client (secret key)
scripts/
  add-pages.mjs   append scans from images/incoming/
  dev-local.sh    run the app against the local Supabase stack
  keepalive.sh    one ping, run by both schedulers
  keepalive.plist launchd template (placeholders; use the installer)
  install-keepalive.sh  installs the local agent and verifies it
supabase/
  config.toml     local stack: which services run (several are off)
  migrations/     timestamped SQL, applied by `supabase db push`
```

Imports can use the `@/` alias for anything under `src/`.

### The scan route

`/api/scan/<pageId>` is the indirection layer. In `local` mode it streams the
file from disk; in `supabase` mode it looks up the row, mints a signed Storage
URL, and redirects to it.

### A page number is not an identity

Reordering rewrites every `page_id` but leaves the same *set* of numbers in
place — 1, 2, 3, 5, 7 … before and after. So anything keyed on the page number
sees no change at all and keeps showing the previous occupant of each slot.

Two things went wrong that way. Image URLs were versioned on `updated_at`, which
only the editor writes, so swapping two never-edited scans produced two
identical URLs and the browser never re-fetched. And React reused each list row
in place, which left `/admin/pages`' uncontrolled first-line box holding the
previous scan's text — pressing Save then wrote it onto the wrong scan.

The fix is `contentIdFor(storage_key)` in `src/lib/pages.js`: a short opaque
hash of the one value that never moves. It keys every page list, so React moves
a row (and its form state) along with its scan, and it goes into `?v=` so an
image URL changes whenever *what sits at that page number* changes. The storage
key itself still never reaches the browser.

This is why `getPageImageUrl()` can stay synchronous. Signed URLs are async and
expire, so returning one directly would make view assembly async and push
changes up into the viewer. Routing through our own endpoint also means signed
URLs are minted only for pages someone actually opens, and no storage key ever
reaches the browser.

## Notes

`SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` must name the **same project**.
The server uses the first and the browser uses the second, and when they drift
the failure is silent and confusing: every server-side query works while every
sign-in is rejected, because logins go to a project that has none of your data.
`src/lib/supabase.js` now throws on a mismatch rather than letting it happen.

Secrets go in `.env.local`, which is gitignored — never commit the secret key.
It bypasses RLS, so it must stay server-side and must never gain a
`NEXT_PUBLIC_` prefix. The publishable key is the opposite: it is *meant* to
ship, which is why it carries the prefix and why RLS being closed is what
actually protects the diary. Editor swap files (`.env.local.swp`) are ignored
too, since they hold the contents of whatever you were editing.

This app is not statically exported, so it needs a host that runs Node (Vercel,
or similar). GitHub Pages serves static files only and can't host it.
