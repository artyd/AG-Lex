"""Phase 0 sanity test: /health responds with status ok."""
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
