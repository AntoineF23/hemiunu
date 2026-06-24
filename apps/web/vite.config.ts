import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is a plain Vite SPA. In dev it runs on 5173 and proxies the
// worker's API + artifact routes to the Hono worker on 4317 (127.0.0.1 only).
// The worker is the ONLY process that imports the Node-only engine.
const WORKER = "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
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
