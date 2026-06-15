// Playwright config — single-origin smoke. Boots FastAPI (which serves the
// built frontend at / and /api/* JSON) with AGLEX_MOCK_AI=1 so analyze /
// reconcile / chat return deterministic fixtures. The DB lives in
// e2e/.tmp and is wiped by globalSetup before each run.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.AGLEX_E2E_PORT || '8765';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const pythonBin = process.platform === 'win32'
  ? path.join('legal_app', 'venv', 'Scripts', 'python.exe')
  : path.join('legal_app', 'venv', 'bin', 'python');

const dbPath = path.join(__dirname, 'e2e', '.tmp', 'aglex-e2e.sqlite');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,            // single backend, shared seeded user
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/globalSetup.js',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Frontend is built in globalSetup; this command only boots the server.
    // run_server.py sets AGLEX_MOCK_AI + DB_PATH before importing the app.
    command: `${pythonBin} e2e/run_server.py`,
    url: BASE_URL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      AGLEX_E2E_PORT: PORT,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
