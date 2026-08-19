import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The demo talks to `packages/server` on 8787. Proxying `/api` keeps the app's
 * fetches same-origin, so there is no CORS story to explain in the video.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env["PALIMPSEST_API"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
})
