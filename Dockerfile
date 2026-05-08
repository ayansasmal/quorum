# Quorum MCP Server — Dockerfile
#
# Used only for local integration testing of the full central stack.
# In production, engineers run the MCP server locally via Claude Code:
#   claude mcp add --scope user quorum -- node <path>/dist/server.js

FROM node:20-alpine

RUN apk add --no-cache curl

RUN npm install -g @as-quorum/mcp

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["quorum-mcp"]
