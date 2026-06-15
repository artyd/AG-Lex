#!/usr/bin/env bash
# AG Lex — production deploy.
# Usage (on the server):  cd /root/ag-lex && ./deploy.sh
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

echo "==> git pull"
git pull --ff-only

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> check soffice (display-PDF pipeline)"
if ! command -v "${SOFFICE_PATH:-soffice}" >/dev/null 2>&1; then
  echo "WARN: '${SOFFICE_PATH:-soffice}' not on PATH — display-PDF rendering will return"
  echo "      404 until installed. On Debian/Ubuntu:"
  echo "        apt-get install --no-install-recommends \\"
  echo "          libreoffice-core libreoffice-writer libreoffice-calc \\"
  echo "          fonts-noto fonts-noto-cjk"
fi

echo "==> systemctl restart aglex"
systemctl restart aglex

echo "==> done"
