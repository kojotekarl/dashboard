import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev server runs on 5173 and proxies API + WS traffic to the Bun server
 * on 127.0.0.1:3000 (see ../server/index.ts). When the dashboard is
 * hosted off-LAN later, set VITE_API_URL and skip the proxy.
 *
 * Proxy entries are matched in order — list /api/ws BEFORE /api so the
 * WebSocket upgrade rule wins over the generic HTTP rule.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1", // IPv4 localhost only — matches the server's BIND_HOST default
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true,
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
