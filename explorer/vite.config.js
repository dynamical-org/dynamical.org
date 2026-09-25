// Library build: an ES module entry at public/explorer/explorer.js with its
// lazily loaded chunks (blosc/zstd WASM, ...) beside it. Chunk and asset URLs
// are resolved relative to the entry (import.meta.url), so it works from
// /explorer/ without knowing the site's base path.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // Library mode leaves process.env.NODE_ENV in dependencies; the browser has no `process`.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    minify: true,
    target: "es2022",
    outDir: fileURLToPath(new URL("../public/explorer", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    lib: {
      entry: fileURLToPath(new URL("src/explorer.js", import.meta.url)),
      formats: ["es"],
      fileName: () => "explorer.js",
    },
    rollupOptions: {
      output: { chunkFileNames: "[name]-[hash].js", assetFileNames: "[name]-[hash][extname]" },
    },
  },
});
