"""Launcher used by Playwright's webServer.

Sets the e2e env (AGLEX_MOCK_AI + DB_PATH) explicitly before importing
the FastAPI app, so config.get_settings() picks them up regardless of
how the parent process forwarded its environment. Keeps the
playwright.config.js command short and avoids cross-shell quoting fun.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "e2e" / ".tmp" / "aglex-e2e.sqlite"

DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Wipe any leftover DB (and WAL/SHM sidecars) before lifespan boots. We do
# this here instead of in globalSetup because Playwright can start the
# webServer in parallel with globalSetup — wiping there raced with lifespan
# writes and left the test run looking at an empty DB.
for suffix in ("", "-wal", "-shm"):
    leftover = Path(str(DB_PATH) + suffix)
    if leftover.exists():
        try:
            leftover.unlink()
        except OSError:
            pass

os.environ["AGLEX_MOCK_AI"] = "1"
os.environ["DB_PATH"] = str(DB_PATH)
# Fresh JWT secret so test tokens are bounded to this run.
os.environ.setdefault("JWT_SECRET", "e2e-only-not-a-secret")

sys.path.insert(0, str(REPO_ROOT / "legal_app"))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("AGLEX_E2E_PORT", "8765"))
    uvicorn.run("backend.main:app", host="127.0.0.1", port=port, log_level="info")
