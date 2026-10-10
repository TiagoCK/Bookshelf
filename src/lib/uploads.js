/**
 * Whether this server can accept an upload at all.
 *
 * The uploader is the one part of the admin section that cannot run on a
 * serverless deployment, and it fails three separate ways there:
 *
 *   - A Vercel function caps its request body at 4.5 MB. MAX_UPLOAD_BYTES is
 *     100 MB, and a scanned PDF is routinely past both.
 *   - The plan step stages derived JPEGs in os.tmpdir() for the commit step to
 *     pick up. A deployment's temp directory is per-instance, and the two
 *     requests need not land on the same one.
 *   - saveMasters() copies the full-resolution file into images/, and a
 *     deployment's source tree is read-only.
 *
 * Any one of those is fatal on its own, so the honest answer is to refuse and
 * say where to upload instead. Half-working would be worse than refusing: the
 * third failure is silent -- saveMasters() returns 0 rather than throwing --
 * and what reaches Storage is capped at MAX_WIDTH, so a remote upload would
 * quietly leave no full-resolution copy of the scan anywhere.
 *
 * Everything else under /admin is small database writes and is unaffected:
 * creating a volume, setting its visibility, reordering, first lines, people.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Where the full-resolution masters live, when there is anywhere to put them.
 *
 * One definition, in the module that decides whether it can be written to at
 * all. api/scan keeps its own: that one is about serving bytes off disk in
 * local mode, which is a different question about the same directory.
 */
export const SCANS_DIR = path.join(process.cwd(), "images");

/**
 * The reasons, as the admin will read them.
 *
 * Phrased around what to do rather than what went wrong, because nothing has
 * gone wrong -- this is simply the wrong machine to be doing it from.
 */
const WHERE_INSTEAD = "Add scans from the machine that holds your originals.";

export const UPLOADS_OFF = `Uploading is switched off on this server. ${WHERE_INSTEAD}`;

export const UPLOADS_READ_ONLY =
  "This server's files are read-only, so the full-resolution master of a scan " +
  `would have nowhere to go. ${WHERE_INSTEAD}`;

/**
 * The decision, with the inputs handed in.
 *
 * Pure, so the three branches are testable without a read-only directory or a
 * mutated environment -- the same split as canSee() in diary-rules.js.
 *
 * `setting` is DIARY_UPLOADS, and it wins in both directions. Explicit beats
 * inferred, in the spirit of DIARY_SOURCE in pages.js: no silent fallback, and
 * an escape hatch for anyone who means it.
 */
export function uploadVerdict({ setting, treeWritable }) {
  if (setting === "off") return { enabled: false, reason: UPLOADS_OFF };
  if (setting === "on") return { enabled: true };
  return treeWritable ? { enabled: true } : { enabled: false, reason: UPLOADS_READ_ONLY };
}

/**
 * Ask about this server.
 *
 * A writable working directory is the test, rather than the name of a platform,
 * because it is the capability the third failure above actually needs -- and it
 * is false on any host serving this from a read-only tree, not just on the one
 * we happen to have deployed to. So a deployment refuses correctly even when
 * DIARY_UPLOADS was never set.
 *
 * Deliberately not cached. It runs at most twice per upload, against the local
 * filesystem, which is nothing beside rasterising a PDF -- and a cached "no"
 * would outlive the chmod that fixed it.
 */
export async function uploadCapability() {
  let treeWritable = false;
  try {
    await access(process.cwd(), constants.W_OK);
    treeWritable = true;
  } catch {
    // Read-only tree, which is the answer rather than an error.
  }

  return uploadVerdict({ setting: process.env.DIARY_UPLOADS, treeWritable });
}


/**
 * Is there anywhere for the master to go?
 *
 * Separate from uploadCapability(), because the answers mean different things.
 * A missing images/ does not stop an upload -- saveMasters() skips it and the
 * pages are still added -- it only means the file you picked is not kept. The
 * uploader has always behaved that way; this is so it can be said out loud
 * before the upload rather than discovered later by its absence.
 */
export async function hasScansDir() {
  try {
    await access(SCANS_DIR, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
