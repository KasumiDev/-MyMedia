import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "service-worker": entry("./src/background/service-worker.ts"),
        content: entry("./src/content/controller.ts"),
        "page-bridge": entry("./src/page/bridge.ts")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
