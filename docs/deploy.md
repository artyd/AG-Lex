# Deploy — Docker on Hetzner

Production runs three containers behind a single host-facing nginx on
**port 8002**: the FastAPI backend, the Vite/React SPA, and the edge proxy
that merges them under one origin.

```
host:8002 → nginx (edge)
              ├── /api/  → backend  (uvicorn legal_app.backend.main:app, :8000)
              ├── /ws    → backend  (WebSocket, same upstream)
              └── /      → frontend (nginx serving the Vite build, :80)
```

## Local

```bash
cp .env.example .env   # fill API_KEY and JWT_SECRET at minimum
docker compose up -d --build
curl http://localhost:8002/api/health
# {"status":"ok"}
```

Volumes `aglex_db` and `aglex_data` persist `legal_app/database/` (SQLite)
and `legal_app/data/` (codex sources) across rebuilds. Delete them only when
you explicitly want a clean DB.

## CI/CD

`.github/workflows/deploy.yml` runs two jobs on every push:

1. **`build-check`** — installs `legal_app/requirements.txt`, imports the
   FastAPI app to catch import-time regressions, then runs `npm ci && npm run build`.
2. **`deploy`** — only on `main`, only when the three Hetzner secrets are
   set. SSHs in, `git pull`s, rebuilds the three services, and probes
   `http://localhost:8002/api/health`.

If any secret is missing, the deploy step prints a notice and exits 0 so PR
checks stay green for forks and feature branches.

## GitHub secrets

Add under **Settings → Secrets and variables → Actions**:

| Name | Value |
|------|-------|
| `HETZNER_HOST` | Server IP or DNS name |
| `HETZNER_USER` | SSH user (e.g. `root` or `deploy`) |
| `HETZNER_SSH_KEY` | Private SSH key with shell access (ed25519 recommended) |

## Server bootstrap

One-time, on the Hetzner box:

```bash
# 1. Install Docker Engine + the compose plugin.
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin

# 2. Clone the repo to the path the workflow expects.
sudo mkdir -p /opt/aglex
sudo chown "$USER":"$USER" /opt/aglex
git clone https://github.com/artyd/AG-Lex.git /opt/aglex
cd /opt/aglex

# 3. Drop the production .env in place.
cp .env.example .env
nano .env   # set API_KEY, JWT_SECRET, etc.

# 4. First boot.
docker compose up -d --build
curl -f http://localhost:8002/api/health
```

After that, every push to `main` triggers the workflow and the server
self-updates.

### Ownership note

If the repo was cloned by a different user than the one the workflow SSHs in
as (common: `git clone` ran as `root`, deploy uses a `deploy` user), Git
refuses to `git pull` with *"fatal: detected dubious ownership in repository
at '/opt/aglex'"*. The workflow already runs
`git config --global --add safe.directory /opt/aglex` on every deploy, so
this is self-healing. To remove the warning permanently, chown the tree to
the deploy user once:

```bash
sudo chown -R "$DEPLOY_USER":"$DEPLOY_USER" /opt/aglex
```

### Diagnostics

If a deploy fails, SSH in and inspect:

```bash
cd /opt/aglex
docker compose ps
docker compose logs --tail=200 backend
```
