import UploadForm from "@/components/UploadForm";
import { requireAdmin } from "@/lib/auth";
import { requireDiary } from "@/lib/diaries";
import { MAX_WIDTH } from "@/lib/ingest";
import { getPages } from "@/lib/pages";
import { hasScansDir, mb, uploadCapability } from "@/lib/uploads";
import { totalPages } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function UploadPage({ params }) {
  const admin = await requireAdmin();
  const { slug } = await params;
  const diary = await requireDiary(slug, admin);

  // What this particular server can take. Asked before the form is rendered so
  // the ceiling can be stated and enforced in the browser, rather than
  // discovered after a long upload.
  const uploads = await uploadCapability();

  if (!uploads.enabled) {
    return (
      <>
        <h2>Upload — {diary.title}</h2>
        <p className="admin__note">{uploads.reason}</p>
        <p className="admin__note">
          There, <code>npm run add</code> and this page do the same work through
          the same pipeline. Everything else in the admin section — visibility,
          page order, first lines, people — works from anywhere.
        </p>
      </>
    );
  }

  // Only to show where the new pages would land. The commit route works this
  // out again for itself against the database at the moment it writes.
  const pages = await getPages(diary.id);

  // Whether the master will actually be kept. saveMasters() skips silently when
  // the directory is absent, and what reaches Storage is downscaled -- so
  // without this the only full-resolution copy is lost with no sign of it.
  const keepsMasters = await hasScansDir();

  return (
    <>
      <h2>Upload — {diary.title}</h2>
      <p className="admin__note">
        Adds scans to the <strong>end</strong> of the diary, the same as{" "}
        <code>npm run add</code>. A PDF becomes one diary page per PDF page, in
        order. Pages are stored as JPEG at up to {MAX_WIDTH}px wide
        {keepsMasters ? (
          <>
            ; the file you pick is also kept in <code>images/</code> as the
            full-resolution master.
          </>
        ) : (
          "."
        )}
      </p>

      {/*
        Said before the upload, not after it fails.

        The permanence line looks like it is stating the obvious, and it is here
        precisely because it is not: the natural assumption about a deployment
        is that it is a scratch copy. It is not -- this writes to the same
        Supabase project everything else reads from.
      */}
      {uploads.ephemeral && (
        <div className="admin__note">
          <p>
            <strong>Uploading from the deployment, not your laptop.</strong>{" "}
            Three things follow from that:
          </p>
          <ul>
            <li>
              Files are limited to <strong>{mb(uploads.maxBytes)} MB</strong>,
              which is what this host accepts in one request. A long PDF is
              almost certainly over it — add those from the machine that holds
              your originals.
            </li>
            <li>
              Pages added here are <strong>permanent and public straight
              away</strong>, exactly as if you had added them locally. They go
              to the same database and the same storage; nothing here is a
              preview.
            </li>
            <li>
              The two steps are separate requests. If they land on different
              instances you will be asked to choose the file again — retry, and
              nothing is lost or half-written.
            </li>
          </ul>
        </div>
      )}

      {!keepsMasters && (
        <p className="admin__note">
          <strong>No <code>images/</code> directory here.</strong> The upload
          will work, but the file you pick is not kept — only the downscaled
          JPEG in Storage. Create <code>images/</code> first if this scan is one
          you want a full-resolution copy of.
        </p>
      )}

      <UploadForm
        lastPage={totalPages(pages)}
        diaryId={diary.id}
        diarySlug={diary.slug}
        maxBytes={uploads.maxBytes}
      />
    </>
  );
}
