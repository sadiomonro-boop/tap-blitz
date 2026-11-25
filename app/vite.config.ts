import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages project site: served from /<repo>/ — keep relative so the
  // same build works on any Pages URL.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
