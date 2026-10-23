/** @type {import('next').NextConfig} */
const nextConfig = {
  /*
   * Native modules the bundler must leave alone.
   *
   * sharp and @napi-rs/canvas load prebuilt .node binaries, and pdfjs resolves
   * its worker and standard font files by path at runtime. Bundling any of them
   * breaks those lookups, and the failure surfaces only when a route actually
   * runs -- not at build time.
   */
  serverExternalPackages: ["sharp", "@napi-rs/canvas", "pdfjs-dist"],

  /*
   * The one pdfjs file nothing imports, and that therefore never reached the
   * deployment.
   *
   * serverExternalPackages above keeps pdfjs out of the bundle, which leaves
   * Next's output file tracing to copy the parts of node_modules a function
   * needs. Tracing follows import statements; pdfjs reaches its worker by
   * building a path at run time, so the trace had no idea it existed and the
   * first PDF upload on Vercel died with "Setting up fake worker failed:
   * Cannot find module .../pdfjs-dist/legacy/build/pdf.worker.mjs".
   *
   * standard_fonts/ deliberately is NOT listed. rasterisePdf() reaches those by
   * runtime path too, so they look like the same bug -- but the trace already
   * carries all 16 of them, measured in the .nft.json rather than assumed, and
   * adding them again only duplicates entries.
   *
   * Scoped to the one route that rasterises rather than "/*": the plan route is
   * the only caller of rasterisePdf(), and the worker is 2.4 MB that the other
   * functions have no use for. None of this can reproduce locally, where
   * node_modules is simply present.
   */
  outputFileTracingIncludes: {
    "/api/admin/upload/plan": ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
