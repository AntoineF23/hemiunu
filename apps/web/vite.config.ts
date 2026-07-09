import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client is a plain Vite SPA. In dev it runs on 5173 and proxies the
// worker's API + artifact routes to the Hono worker on 4317 (127.0.0.1 only).
// The worker is the ONLY process that imports the Node-only engine.
const WORKER = "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@` → the client source root, so shadcn's `@/components` and `@/lib/utils`
    // imports resolve (matches tsconfig paths).
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: WORKER, changeOrigin: false },
      "/preview": { target: WORKER, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist/client",
  },
});
