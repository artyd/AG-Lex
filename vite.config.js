import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy targets a locally running FastAPI backend.
// REST goes through /api, realtime through /ws. The backend mounts both at
// the same origin in production, so the proxy is a dev-only convenience to
// keep the frontend talking to /api/... and ws://.../ws regardless of port.
//
// IMPORTANT: run the backend with a single uvicorn worker — the in-memory
// ConnectionManager that fans out WebSocket events lives in the worker
// process and won't cross process boundaries:
//   uvicorn legal_app.backend.main:app --workers 1 --port 8000
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
