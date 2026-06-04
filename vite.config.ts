import { defineConfig } from "vite";

// GitHub Pages serves from the repo root or /<repo> subpath. We're using
// the repo root (tsteinke11306.github.io/angler), so the base is /angler/.
const REPO_NAME = "angler";

export default defineConfig({
  base: `/${REPO_NAME}/`,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inline the data file into the bundle so there's no fetch needed.
    // The data is ~125KB minified, fully under the 1MB warning threshold.
    assetsInlineLimit: 256 * 1024,
  },
  // During dev, vite serves the static data file from /public/data/
  publicDir: "public",
});
