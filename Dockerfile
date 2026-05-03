# ── Builder stage ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY mcp/package.json ./mcp/
COPY gateway/package.json ./gateway/
COPY dashboard/package.json ./dashboard/
RUN npm ci --only=production --workspaces --include-workspace-root

# ── Runtime stage ──────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY mcp/ ./mcp/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["node", "mcp/src/server.js"]
