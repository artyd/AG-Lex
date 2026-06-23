# AG Lex backend — FastAPI (legal_app.backend.main:app) on uvicorn.
#
# Build context: repo root. The image installs:
#   - LibreOffice headless (soffice) + Noto fonts for the display-PDF pipeline
#     (DOCX/XLSX → PDF). Without these, /api/upload returns display_pdf_error
#     but the markdown analysis still works.
#   - build-essential for native wheels (sentence-transformers / sqlite-vec).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      libreoffice-core \
      libreoffice-writer \
      libreoffice-calc \
      fonts-noto \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so source-only edits don't bust the layer cache.
COPY legal_app/requirements.txt /app/legal_app/requirements.txt
RUN pip install --upgrade pip \
 && pip install -r /app/legal_app/requirements.txt

# Backend source. The runtime CWD is /app/legal_app so the
# `from scripts.seed_demo import seed_all` line in main.lifespan() resolves
# against /app/legal_app/scripts/, not the unrelated repo-level scripts/
# folder that only carries the docs generator.
COPY legal_app /app/legal_app

# Volume targets: SQLite + codex sources persist across rebuilds.
RUN mkdir -p /app/legal_app/database /app/legal_app/data

WORKDIR /app/legal_app

EXPOSE 8000

# Single worker: realtime.ConnectionManager keeps the WS fan-out in-process
# (see vite.config.js comment) — multiple workers would silently drop events.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
