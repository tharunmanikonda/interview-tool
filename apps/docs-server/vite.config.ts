import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: "public",
    rollupOptions: {
      input: "viewer/main.tsx",
      output: {
        entryFileNames: "assets/viewer.js",
        chunkFileNames: "assets/viewer-[hash].js",
        assetFileNames: "assets/viewer-[name][extname]"
      }
    }
  }
});
