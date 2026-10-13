import path from "node:path";
import sharp from "sharp";

import { getCurrentUser } from "@/lib/auth";
import {
  analyse,
  IMAGE_EXTENSIONS,
  IMAGE_MIME,
  MAX_PDF_PAGES,
  PDF_MIME,
  rasterisePdf,
  safeFileName,
} from "@/lib/ingest";
import { createStaging, discard, sweep, writeItem, writePlan } from "@/lib/ingest-staging";
import { mb, uploadCapability } from "@/lib/uploads";

/**
 * Step one of an upload: work out what pages this file would become.
 *
 * Writes nothing to the database or to Storage. It exists so the single/spread
 * guess can be corrected before it is committed -- page_count fixes the
 * numbering of every page added after it, and nothing in the app can edit it
 * afterwards.
 *
 * A route handler rather than a server action: server actions cap request
 * bodies at 1 MB and a PDF is far past that.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  // Checked here, not only on the page that renders the form. A route is a
  // publicly reachable endpoint of its own.
  const user = await getCurrentUser();
  if (!user) return json({ ok: false, message: "Unauthorized." }, 401);
  if (!user.isAdmin) return json({ ok: false, message: "Admins only." }, 403);

  /*
   * Before the body is touched, and after the checks above.
   *
   * Order matters in both directions. A stranger still gets 401 rather than a
   * tour of what this server can do; and pulling a 100 MB arrayBuffer() into
   * memory on a host that cannot finish the job is pure waste -- on a
   * deployment the read fails at 4.5 MB with a platform error that explains
   * nothing about where to upload instead.
   */
  const uploads = await uploadCapability();
  if (!uploads.enabled) return json({ ok: false, message: uploads.reason }, 503);

  await sweep();

  /*
   * The file arrives as the raw request body, not as multipart form data.
   *
   * request.formData() goes through a parser that refuses bodies over about
   * 10 MB with "Failed to parse body as FormData" -- measured, not assumed:
   * 8 MB parses and 10 MB does not. A scanned PDF of any length is past that,
   * and the failure gives the caller nothing useful to act on. Reading the body
   * directly has no such ceiling, so the only limit is the explicit one below.
   */
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > uploads.maxBytes) return tooLarge(declared, uploads);

  // decodeURIComponent throws on a malformed escape, and this header comes from
  // the caller. Falling back to the raw value keeps a hand-made request with a
  // stray "%" in the filename on the normal error path instead of an unhandled
  // 500; safeFileName strips whatever survives either way.
  const rawName = request.headers.get("x-upload-filename") ?? "";
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    decodedName = rawName;
  }
  const originalName = safeFileName(decodedName || "upload");
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();

  let buffer;
  try {
    buffer = Buffer.from(await request.arrayBuffer());
  } catch (error) {
    return json({ ok: false, message: `Could not read the upload: ${error.message}` }, 400);
  }

  if (buffer.byteLength === 0) return json({ ok: false, message: "That file is empty." }, 400);
  // Checked again against what actually arrived: content-length is the
  // caller's claim, and a hand-made request can understate it.
  if (buffer.byteLength > uploads.maxBytes) return tooLarge(buffer.byteLength, uploads);

  const extension = path.extname(originalName).toLowerCase();
  const isPdf = contentType === PDF_MIME || extension === ".pdf";
  const isImage = IMAGE_MIME.has(contentType) || IMAGE_EXTENSIONS.has(extension);

  if (!isPdf && !isImage) {
    return json(
      {
        ok: false,
        message: `${originalName} is not an image or a PDF. Accepted: ${[
          ...IMAGE_EXTENSIONS,
        ].join(", ")}, .pdf`,
      },
      415
    );
  }

  const stagingId = await createStaging();

  try {
    const items = [];

    /**
     * Analyse one source image and stage it.
     *
     * Called straight from the PDF rasteriser's per-page callback so a page's
     * PNG is written to disk and released before the next is rendered -- the
     * whole document is never in memory at once.
     */
    const stage = async (bytes, { masterName, masterExt, label }) => {
      const index = items.length;
      const scan = await analyse(bytes);

      await writeItem(stagingId, index, { derived: scan.bytes, master: bytes, masterExt });

      items.push({
        index,
        label,
        masterName,
        masterExt,
        pageCount: scan.pageCount,
        guessed: scan.guessed,
        width: scan.width,
        height: scan.height,
        byteSize: scan.byteSize,
        sourceWidth: scan.sourceWidth,
        sourceHeight: scan.sourceHeight,
        thumbnail: await thumbnail(scan.bytes),
      });
    };

    // A PDF becomes one source image per page; a plain image is a batch of one.
    // Both take the identical path through analyse().
    if (isPdf) {
      const base = originalName.replace(/\.pdf$/i, "");
      try {
        await rasterisePdf(buffer, {
          maxPages: MAX_PDF_PAGES,
          onPage: (png, n) =>
            stage(png, {
              // One master image per page: local mode needs an image per page
              // and cannot serve a PDF.
              masterName: `${base}-p${String(n).padStart(3, "0")}.png`,
              masterExt: ".png",
              label: `${originalName} — page ${n}`,
            }),
        });
      } catch (error) {
        await discard(stagingId);
        return json({ ok: false, message: `Could not read that PDF: ${error.message}` }, 400);
      }
      if (items.length === 0) {
        await discard(stagingId);
        return json({ ok: false, message: "That PDF has no pages." }, 400);
      }
    } else {
      try {
        await stage(buffer, {
          masterName: originalName,
          masterExt: extension || ".jpg",
          label: originalName,
        });
      } catch (error) {
        await discard(stagingId);
        return json(
          { ok: false, message: `${originalName} could not be read: ${error.message}` },
          400
        );
      }
    }

    // The master list is kept server-side; commit re-reads it rather than
    // trusting filenames sent back by the browser.
    await writePlan(stagingId, { items, source: originalName, isPdf });

    return json({
      ok: true,
      stagingId,
      source: originalName,
      isPdf,
      // Thumbnails and guesses only -- no page numbers yet. Those depend on the
      // single/spread choices and are worked out at commit, against the
      // database as it is then.
      items,
    });
  } catch (error) {
    await discard(stagingId);
    return json({ ok: false, message: error.message }, 500);
  }
}

/** A small preview, inline, so the plan renders without another round trip. */
async function thumbnail(jpeg) {
  const data = await sharp(jpeg)
    .resize({ width: 200, withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

/**
 * Over the ceiling for this host.
 *
 * Names both numbers, because "too large" without the limit leaves the admin
 * guessing how much to shave off. The second sentence only appears where the
 * ceiling is the host's rather than ours -- that is the case where there is
 * somewhere better to go.
 */
function tooLarge(size, uploads) {
  const where = uploads.ephemeral
    ? " Upload it from the machine that holds your originals instead."
    : "";
  return json(
    {
      ok: false,
      message:
        `That file is ${mb(size)} MB. This server accepts up to ` +
        `${mb(uploads.maxBytes)} MB.${where}`,
    },
    413
  );
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
