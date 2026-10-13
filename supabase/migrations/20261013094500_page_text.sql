-- Recognised text for a scan, so search can find more than a typed first line.
--
-- Its own table, not a column on pages, for one specific reason: readSupabasePages()
-- in src/lib/pages.js reads with select("*") on purpose -- naming columns would
-- make the app hard-fail during the gap between deploying a change and running
-- its migration. That is worth keeping, and it means a column here would be
-- loaded on every render of every page of the reader, forever, for text the
-- reader never shows. A separate table is simply never touched by that query.
--
-- Keyed on storage_key, never on page_id. The reorder function rewrites every
-- page_id in a diary, so text keyed on the number would silently reattach to
-- the wrong scans the first time a volume was reordered -- the same reasoning
-- the reorder migration gives for identifying scans by storage_key, and the
-- same reasoning the generated manifest gives for storing it.
--
-- Safe to re-run.

create table if not exists page_text (
  storage_key text primary key references pages(storage_key) on delete cascade,

  -- The whole page, newlines intact. firstLineOf() in src/lib/page-text.js
  -- derives a first line from it; the line is not stored twice.
  text text not null,

  -- Which engine produced it, and whether a human has since fixed it.
  --   tesseract  local OCR, good on print
  --   claude     a vision model, which is what handwriting needs
  --   manual     corrected by an admin -- re-running recognition must not
  --              overwrite this, which is the whole point of recording it
  source text not null check (source in ('tesseract', 'claude', 'manual')),

  created_at timestamptz not null default now(),
  edited_at  timestamptz
);

-- RLS on with no policies, exactly as pages and diaries.
--
-- This table is more sensitive than it looks: it is the diary's contents as
-- plain, greppable text, where pages only holds metadata and a storage key. If
-- the publishable key could read one table in this schema, this is the worst
-- one to pick. Every read goes through the server holding the secret key.
alter table page_text enable row level security;
