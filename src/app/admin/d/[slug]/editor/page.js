import { requireAdmin } from "@/lib/auth";
import { requireDiary } from "@/lib/diaries";
import { DIARY_SOURCE, getPages } from "@/lib/pages";
import { buildViews, frameAspect, totalPages } from "@/lib/views";
import EditorBrowser from "@/components/EditorBrowser";

export const dynamic = "force-dynamic";

export default async function ImageEditorIndex({ params }) {
  const admin = await requireAdmin();
  const { slug } = await params;
  const diary = await requireDiary(slug, admin);

  // Editing writes to Supabase Storage. In local mode there is nothing to write
  // to, and writing back into images/ would damage the master scans.
  if (DIARY_SOURCE === "local") {
    return (
      <>
        <h2>Image Editor — {diary.title}</h2>
        <p className="admin__note">
          Unavailable while <code>DIARY_SOURCE=local</code>. Editing writes to Supabase
          Storage; in local mode the only copies are your master scans in{" "}
          <code>images/</code>, which this app never writes to. Set{" "}
          <code>DIARY_SOURCE=supabase</code> in <code>.env.local</code> to edit.
        </p>
      </>
    );
  }

  const pages = await getPages(diary.id);
  const views = buildViews(pages);

  return (
    <>
      <h2>Image Editor — {diary.title}</h2>
      <p className="admin__note">
        Browse to a scan and choose Edit to rotate or crop it. Saving overwrites the
        image the volume serves; the scan as originally uploaded is kept so a change
        can be undone.
      </p>

      <div style={{ "--frame-aspect": frameAspect(views) }}>
        <EditorBrowser diarySlug={diary.slug} views={views} totalPages={totalPages(pages)} />
      </div>
    </>
  );
}
