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

echo "==> systemctl restart aglex"
systemctl restart aglex

echo "==> done"
