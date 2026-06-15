// Runs once before any tests. Two jobs:
//   1. Wipe the e2e scratch DB so each run starts from the seeded baseline.
//   2. Build the frontend so FastAPI's spa_fallback has something to serve.
// We do the build here (not in webServer.command) because on Windows the
// `npm run build && python ...` chain spawned by Playwright sometimes
// leaves the python child with a different cwd/env than expected.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export default async function globalSetup() {
  fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
  // DB wipe lives inside e2e/run_server.py so it runs *before* lifespan
  // and not racy with the parallel webServer startup.
  // Build once before booting the server. Skip with PLAYWRIGHT_SKIP_BUILD=1
  // when iterating on test code without touching the frontend.
  if (!process.env.PLAYWRIGHT_SKIP_BUILD) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}
