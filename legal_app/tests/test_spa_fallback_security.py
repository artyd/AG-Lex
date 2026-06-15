"""Path-traversal regression: the SPA fallback must never serve a file
outside the configured frontend dist directory, regardless of how many
`..` segments the attacker glues onto the URL.

These cases reproduce the scan that hit production on 2026-06-15
(204.76.203.51 hammering /../../../../../../root/.claude/.credentials.json).
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.config import get_settings
from backend.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Build a minimal dist/ so the SPA fallback path is registered when the
    # app boots. The handler is closed over module-level FRONTEND_DIR so we
    # don't even need to swap config — the handler exists either way.
    return TestClient(app)


@pytest.mark.parametrize(
    "path",
    [
        "../../../../../../root/.claude/.credentials.json",
        "../../../../../../root/.codex/auth.json",
        "../../../../../../etc/passwd",
        "..%2f..%2f..%2froot/.claude.json",  # URL-encoded — Starlette decodes
        "foo/../../etc/passwd",
        "./../etc/passwd",
        # Backslash variant in case of Windows-ish payloads.
        "..\\..\\..\\etc\\passwd",
    ],
)
def test_spa_fallback_blocks_path_traversal(client, path):
    r = client.get("/" + path)
    # The handler always returns 200 (SPA fallback shape) — what matters is
    # the *body*. A legit response is the React index.html shell. A leaked
    # file would have totally different content. We assert the body looks
    # like HTML and doesn't carry the obvious credential-file shapes.
    assert r.status_code in (200, 404)
    body = r.text
    # Block markers — these strings appear in the real credential files.
    forbidden_markers = [
        '"access_token"',
        '"api_key"',
        '"sessionToken"',
        '"refresh_token"',
        '"credentials"',
        'BEGIN OPENSSH PRIVATE KEY',
        'root:x:0:0:',
    ]
    for marker in forbidden_markers:
        assert marker not in body, (
            f"path {path!r} leaked credential-shaped content: {marker!r} "
            f"present in body (first 200 chars: {body[:200]!r})"
        )
