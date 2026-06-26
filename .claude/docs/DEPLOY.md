# Deploy

Production runs `docker compose up` on a Hetzner VM. CI/CD via GitHub
Actions SSH into the box.

## Topology

```
host:8002 → nginx (edge container)
              ├── /api/  → backend  (uvicorn legal_app.backend.main:app, :8000)
              ├── /ws    → backend  (WebSocket, same upstream)
              └── /      → frontend (nginx serving the Vite build, :80)
```

Edge config: `nginx/default.conf`. Two upstreams, one host port (8002).
`client_max_body_size 30m` matches the backend's 25 MB upload cap with
slack. WS upgrade headers + `proxy_read_timeout 3600s` keep long
connections alive.

## Volumes (persistent)

| Volume       | Mount                                   | Purpose                  |
|--------------|-----------------------------------------|--------------------------|
| `aglex_db`   | `/app/legal_app/database`               | SQLite file              |
| `aglex_data` | `/app/legal_app/data`                   | codex sources            |

**Never delete by hand.** Use `docker compose down -v` only when you
explicitly want a clean DB (codex re-import takes minutes).

## CI/CD (`.github/workflows/deploy.yml`)

Two jobs:

1. **`build-check`** (every PR + push)
   - Python 3.12 + `pip install -r legal_app/requirements.txt`
   - Imports the FastAPI app: `from legal_app.backend.main import app`
   - Node 20 + `npm ci && npm run build`
2. **`deploy`** (push to `main` only, only if Hetzner secrets are set)
   - SSH in, `git pull`, `docker compose up -d --build backend frontend nginx`
   - `docker compose restart nginx; sleep 15; curl -fsS http://localhost:8002/api/health`
   - Exits 0 with a notice if `HETZNER_HOST / USER / SSH_KEY` aren't set
     (forks + feature branches stay green).

Required secrets:
- `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` (ed25519 private key).

## The 15s health-check window

After `docker compose restart nginx`, the workflow sleeps 15s then
probes `/api/health`. This is why `lifespan` starts the codex bootstrap
in a **background thread** — synchronous bootstrap on a fresh
`aglex_db` volume downloads sentence-transformers (~200 MB) and
embeds ~2 500 articles, blocking past the probe and 502-ing nginx.
See PR #60.

If you add anything to lifespan that can take more than a few seconds,
fork it to a background thread the same way (`threading.Thread(target=...
daemon=True).start()`) or move it to a one-off script.

## Server bootstrap (one-time)

```bash
sudo mkdir -p /opt/aglex
sudo chown "$USER":"$USER" /opt/aglex
git clone https://github.com/artyd/AG-Lex.git /opt/aglex
cd /opt/aglex
cp .env.example .env       # set API_KEY, JWT_SECRET, etc.
docker compose up -d --build
curl -f http://localhost:8002/api/health
```

If `/opt/aglex` was cloned as `root` but the deploy SSH user is different,
Git refuses `git pull` with *"dubious ownership"*. The workflow already
runs `git config --global --add safe.directory /opt/aglex` per deploy as
a self-heal — see PR #49.

## Manual deploy fallback (`./deploy.sh`)

When CI is broken, SSH into the server and run:

```bash
cd /opt/aglex && ./deploy.sh
```

The script does `git pull → npm ci → npm run build → systemctl restart
aglex`. **Note:** the script targets the older systemd-based deploy; the
docker-compose path is what CI uses. Treat `./deploy.sh` as a legacy
fallback unless you've explicitly migrated back.

## Diagnostics

```bash
cd /opt/aglex
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=200 nginx
```

## Things to remember

- **Single uvicorn worker.** Backend Dockerfile pins `--workers 1`.
  Realtime fan-out is in-process. Don't change without Redis pub/sub.
- **MIME types matter for nginx-served `.mjs` assets** (pdf.js worker).
  PR #55 added the explicit MIME mapping in `docker/frontend.nginx.conf`.
- **Edge nginx, not Caddy.** Earlier history referenced Caddy — current
  prod is docker-compose nginx.
- **`MAX_DISPLAY_PDF_BYTES` defaults to 40 MB.** soffice can produce
  unexpectedly large PDFs from complex DOCX; the cap is the safety net
  against runaway BLOBs.
