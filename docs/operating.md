# Operating an instance

Everything needed to deploy Bookshelf, point it at a Supabase project, and keep
that project from going to sleep. For what the code does and why, see
[design.md](design.md); for getting scans into it, [adding-pages.md](adding-pages.md).

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

### Two different body limits

Worth keeping straight, because they are easy to confuse and only one of them is
Vercel's:

| | Limit | Where it applies |
|---|---|---|
| Next's `proxyClientMaxBodySize` | 10 MB, **silently truncating** | everywhere, including locally |
| Vercel's function request body | 4.5 MB, `413` | the deployment only |

The Next one is the subtler problem. `proxy` buffers every matched request body
in memory and, past the limit, carries on with a partial body rather than
failing — so an oversized upload surfaced as `VipsJpeg: premature end of JPEG
image`, which sends you looking at the file rather than the limit. Measured by
bisection against `next dev`: 9.32 MB decoded, 10.58 MB did not, and raising
`proxyClientMaxBodySize` made the identical 10.58 MB file decode.

`src/proxy.js` therefore excludes `/api/admin/upload` from its matcher, so those
bodies are never buffered. Both routes already do their own `getCurrentUser()`
and `isAdmin` checks — the proxy is a convenience redirect, not the security
boundary — and they answer `503` during an outage themselves, which is what the
proxy was doing for them before.

Everything else in the admin section works from anywhere, because it is all
small database writes: creating a volume, **setting its visibility**, reordering
pages, filling in first lines, changing roles.

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

