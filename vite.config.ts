import { defineConfig } from "vite";

// GitHub Pages serves from the repo root or /<repo> subpath. The repo
// is named 'angl3r' on GitHub, so the base path is /angl3r/.
const REPO_NAME = "angl3r";

export default defineConfig({
  base: `/${REPO_NAME}/`,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep the JSON data file as a separate static asset. It is fetched
    // at runtime by src/main.ts, so inlining it into the JS bundle would
    // bloat first-load size and duplicate the download.
  },
  // During dev, vite serves the static data file from /public/data/
  publicDir: "public",
});
