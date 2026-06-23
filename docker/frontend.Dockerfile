# AG Lex frontend — Vite/React build served by nginx.
#
# Build context: repo root (Vite lives at the root, not under frontend/).
# The runtime stage ships a tiny SPA nginx with try_files fallback so client
# routes survive a hard reload.

# --- Stage 1: build the Vite bundle ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# --- Stage 2: nginx serves dist/ as a SPA ---
FROM nginx:alpine AS runtime
COPY docker/frontend.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
