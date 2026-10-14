/**
 * How large an upload this server can take, and what to say about it.
 *
 * This used to be a yes/no gate that refused outright on a deployment. The
 * argument for refusing was that saveMasters() writes the full-resolution file
 * into images/ and a deployment's tree is read-only, so a remote upload would
 * silently keep no master. That argument turned out not to apply: there is no
 * images/ in this repository either, so saveMasters() already returns 0 locally
 * and nothing is being kept in the first place. A deployment therefore loses
 * nothing relative to uploading from a laptop, and refusing bought nothing.
 *
 * What genuinely differs is the size of the request a host will accept, so that
 * is what this module answers now.
 *
 *   writable tree   MAX_UPLOAD_BYTES -- a laptop, where the originals live
 *   read-only tree  PLATFORM_MAX_UPLOAD_BYTES -- a serverless deployment
 *
 * Two things a deployment still cannot promise, both said out loud on the
 * upload page rather than discovered:
 *
 *   - The plan and commit steps are separate requests, and the derived JPEGs
 *     wait between them in os.tmpdir(). Fluid compute shares one instance
 *     across invocations so this usually survives; when it does not, the commit
 *     route already answers "That upload has expired. Choose the file again."
 *     That is a retry, not a loss.
 *   - No full-resolution master is kept. Same as here, today.
 *
 * What a deployment does NOT change is permanence. A commit writes rows to
 * Postgres and objects to Storage in the same shared Supabase project the local
 * app uses, so a page added from the deployment is live for everyone
 * immediately. Nothing about it is a preview.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { MAX_UPLOAD_BYTES } from "./ingest.js";

/**
 * Where the full-resolution masters live, when there is anywhere to put them.
 *
 * One definition, in the module that decides what this host can do with it.
 * api/scan keeps its own: that one is about serving bytes off disk in local
 * mode, which is a different question about the same directory.
 */
export const SCANS_DIR = path.join(process.cwd(), "images");

/**
 * The ceiling on a host that cannot take a large request.
 *
 * Vercel documents 4.5 MB as the maximum request body for a function, answering
 * 413 FUNCTION_PAYLOAD_TOO_LARGE above it. We advertise and enforce 4 MB so the
 * refusal comes from us, with a message that says where to upload instead,
 * rather than from the platform after the whole file has been sent.
 *
 * Not named for Vercel. Any serverless host has a limit of this kind, and the
 * read-only tree is what we actually detect.
 */
export const PLATFORM_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** One decimal place of megabytes, so every message agrees on the number. */
export const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

export const UPLOADS_OFF =
  "Uploading is switched off on this server. Add scans from the machine that " +
  "holds your originals.";

/**
 * The limits, with the inputs handed in.
 *
 * Pure, so its branches are testable without a read-only directory or a mutated
 * environment -- the same split as canSee() in diary-rules.js.
 *
 * `setting` is DIARY_UPLOADS, and "off" is the only value it reads. There is
 * deliberately no "on": the smaller ceiling is a property of the host, not a
 * policy, and a flag that claimed to lift it would only move the failure to the
 * platform's opaque 413.
 */
export function uploadLimits({ setting, treeWritable }) {
  const maxBytes = treeWritable ? MAX_UPLOAD_BYTES : PLATFORM_MAX_UPLOAD_BYTES;

  // `ephemeral` is what the upload page keys its caveats on: no master kept,
  // and a staging directory that may not survive to the commit request.
  const ephemeral = !treeWritable;

  if (setting === "off") {
    return { enabled: false, maxBytes, ephemeral, reason: UPLOADS_OFF };
  }
  return { enabled: true, maxBytes, ephemeral };
}

/**
 * Ask about this server.
 *
 * A writable working directory is the test, rather than the name of a platform,
 * because it is the capability that actually differs -- and it is false on any
 * host serving this from a read-only tree, not just on the one we happen to
 * have deployed to.
 *
 * Deliberately not cached. It runs at most twice per upload, against the local
 * filesystem, which is nothing beside rasterising a PDF -- and a cached answer
 * would outlive the chmod that changed it.
 */
export async function uploadCapability() {
  let treeWritable = false;
  try {
    await access(process.cwd(), constants.W_OK);
    treeWritable = true;
  } catch {
    // Read-only tree, which is the answer rather than an error.
  }

  return uploadLimits({ setting: process.env.DIARY_UPLOADS, treeWritable });
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
