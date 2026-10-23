# Design notes

Why the access model, the page model, the search and the layout work the way
they do. The short version is in the main [README](../README.md); this is the
reasoning behind it.

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

A scan is found by its typed first line **or** by text recognised from the page
(see below). Both go through the same `matchesQuery()`; recognition added a
second place to look, not a second rule. A hit from the page body is labelled as
such, because it is a machine's reading rather than a human's summary.

The viewer's live filter stays first-line-only. It filters pages already in
memory, and page text is deliberately kept out of that payload.

Matching runs in the app, not in Postgres. `getPages()` already loads every
row's metadata on every render, so filtering 14 rows is free, and one rule beats
two that disagree — `ilike` folds case by its own collation and would not match
the filter running in the browser. **Past a few thousand scans**, move this to
`ilike` with a `pg_trgm` index and have the viewer's live filter call it; full
page text makes that threshold arrive sooner.

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

