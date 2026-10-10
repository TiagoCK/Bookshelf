import UploadForm from "@/components/UploadForm";
import { requireAdmin } from "@/lib/auth";
import { requireDiary } from "@/lib/diaries";
import { MAX_WIDTH } from "@/lib/ingest";
import { getPages } from "@/lib/pages";
import { hasScansDir, uploadCapability } from "@/lib/uploads";
import { totalPages } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function UploadPage({ params }) {
  const admin = await requireAdmin();
  const { slug } = await params;
  const diary = await requireDiary(slug, admin);

  /*
   * Asked before the form is rendered, not after it is submitted.
   *
   * The routes refuse too -- they are the boundary -- but a form that cannot
   * work is worse than no form: on a deployment it would fail at 4.5 MB with a
   * platform error, after the admin had waited for the file to upload.
   */
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

      {!keepsMasters && (
        <p className="admin__note">
          <strong>No <code>images/</code> directory here.</strong> The upload
          will work, but the file you pick is not kept — only the downscaled
          JPEG in Storage. Create <code>images/</code> first if this scan is one
          you want a full-resolution copy of.
        </p>
      )}

      <UploadForm lastPage={totalPages(pages)} diaryId={diary.id} diarySlug={diary.slug} />
    </>
  );
}
