#!/usr/bin/env bash
set -euo pipefail

echo "── Quorum Setup ───────────────────────────────────────────"

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  echo "✗ Node.js 20+ required. Got: $(node --version 2>/dev/null || echo 'not found')"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "✗ Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi
echo "✓ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Copy env file if not present
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ Created .env from .env.example — add your OPENAI_API_KEY before starting"
else
  echo "✓ .env already exists"
fi

# Check for API key
if ! grep -q "^OPENAI_API_KEY=sk-" .env 2>/dev/null; then
  echo ""
  echo "⚠  OPENAI_API_KEY is not set in .env"
  echo "   Edit .env and add: OPENAI_API_KEY=sk-..."
  echo "   Graphiti requires an LLM to extract entities from knowledge."
  echo ""
fi

# Start Docker stack
echo ""
echo "Starting Docker stack (FalkorDB + PostgreSQL + Graphiti + Quorum)..."
docker compose up -d

# Wait for health checks
echo "Waiting for services to be healthy..."
TIMEOUT=60
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  FALKORDB=$(docker compose ps --format json falkordb 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health',''))" 2>/dev/null || echo "")
  POSTGRES=$(docker compose ps --format json postgresql 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health',''))" 2>/dev/null || echo "")

  if [ "$FALKORDB" = "healthy" ] && [ "$POSTGRES" = "healthy" ]; then
    echo "✓ All services healthy"
    break
  fi

  sleep 3
  ELAPSED=$((ELAPSED + 3))
  echo "  waiting... (${ELAPSED}s)"
done

if [ $ELAPSED -ge $TIMEOUT ]; then
  echo "✗ Timed out waiting for services. Check: docker compose ps"
  exit 1
fi

# Run seed data
echo ""
echo "Seeding engineering knowledge..."
npm run seed

echo ""
echo "── Setup complete ─────────────────────────────────────────"
echo ""
echo "To add Quorum to Claude Code:"
echo "  claude mcp add quorum -- node $(pwd)/src/server.js"
echo ""
echo "To verify:"
echo "  node cli.js audit verify"
echo "  node cli.js history auth:token-strategy"
echo ""
