# mock-openai — E2E test OpenAI API mock
# Tiny image: node:20-alpine + the two-file service (server.js + package.json).
# No npm install needed — zero external dependencies.
FROM node:24-alpine

WORKDIR /app

# Copy only what the server needs — no node_modules required.
COPY package.json ./
COPY server.js    ./

EXPOSE 3003

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "server.js"]
