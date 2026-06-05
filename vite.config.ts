import { defineConfig } from "vite";

// GitHub Pages serves from the repo root or /<repo> subpath. The repo
// is named 'angl3r' on GitHub, so the base path is /angl3r/.
const REPO_NAME = "angl3r";

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
