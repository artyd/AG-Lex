FROM node:20-alpine

WORKDIR /app

# `tesseract.js` pulls in node-canvas-free wasm builds, but the image still
# needs a CA bundle for the traineddata fetch on first OCR call.
RUN apk add --no-cache ca-certificates curl

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY index.mjs ./

ENV PORT=3031
ENV NODE_ENV=production
EXPOSE 3031

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3031/health || exit 1

CMD ["node", "index.mjs"]
