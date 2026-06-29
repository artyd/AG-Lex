import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy targets a locally running FastAPI backend.
// REST goes through /api, realtime through /ws. The backend mounts both at
// the same origin in production, so the proxy is a dev-only convenience to
// keep the frontend talking to /api/... and ws://.../ws regardless of port.
//
// Port 8001 matches the AG Lex deployment (Caddy reverse-proxies to :8001).
// Override via the AGLEX_BACKEND_PORT env var if you need to run the backend
// on a different local port without touching this file.
//
// IMPORTANT: run the backend with a single uvicorn worker — the in-memory
// ConnectionManager that fans out WebSocket events lives in the worker
// process and won't cross process boundaries:
//   uvicorn legal_app.backend.main:app --workers 1 --port 8001
const BACKEND_PORT = process.env.AGLEX_BACKEND_PORT || '8001'

export default defineConfig({
  plugins: [react()],
  // Treat .mjs as a first-class asset so PDF.js's `pdf.worker.min.mjs` (and
  // any other ESM-only worker) is served with `Content-Type: application/javascript`
  // by the dev server. Without this, Chrome refuses the dynamic import with
  // "Failed to fetch dynamically imported module".
  assetsInclude: ['**/*.mjs'],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${BACKEND_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  // Vitest auto-discovers *.test.{js,ts} and *.spec.{js,ts} — keep it out of
  // the e2e/ folder so it doesn't try to run Playwright specs under jsdom.
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
