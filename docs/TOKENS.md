# Getting a Fresh Token (Without the Dashboard)

The Quorum Gateway uses ES256 (ECDSA P-256) JWTs that expire after 1 hour.
In local dev, the key pair is **ephemeral** — regenerated every time the gateway container restarts.
This means any token you saved before a `docker compose build gateway` is invalid.

---

## Option 1 — GitHub CLI (recommended for local dev)

```bash
GH_TOKEN=$(gh auth token)
JWT=$(curl -s -X POST http://localhost:3001/auth/token \
  -H "Content-Type: application/json" \
  -d "{\"github_token\": \"$GH_TOKEN\", \"project_id\": \"your-project-id\"}" \
  | jq -r .token)

echo $JWT   # paste anywhere a JWT is needed
```

Requirements: `gh` CLI authenticated (`gh auth login`).

---

## Option 2 — GitHub PAT

Create a PAT at https://github.com/settings/tokens (no scopes needed — just `user:read`).

```bash
JWT=$(curl -s -X POST http://localhost:3001/auth/token \
  -H "Content-Type: application/json" \
  -d '{"github_token":"ghp_YOUR_PAT","project_id":"your-project-id"}' \
  | jq -r .token)
```

---

## Option 3 — Mint directly inside the container (no GitHub needed)

Useful when GitHub is unreachable or you need a token for a specific sub/role without OAuth.

```bash
docker compose exec gateway node --input-type=module <<'EOF'
import { loadKeys, getKeys } from '/app/gateway/src/keys.js'
import { SignJWT }            from 'jose'
await loadKeys()
const { privateKey, kid } = getKeys()
const token = await new SignJWT({ sub: 'your-github-username', is_admin: false })
  .setProtectedHeader({ alg: 'ES256', kid })
  .setIssuer('quorum-gateway')
  .setIssuedAt()
  .setExpirationTime('4h')
  .sign(privateKey)
console.log(token)
EOF
```

**Warning:** This generates a new ephemeral key pair in the Node.js process — different from
the running gateway's key pair. The resulting JWT **will not be accepted** by the live gateway.

To get a token signed by the running gateway's key, use the `/auth/token` HTTP endpoint (Options 1/2).

---

## Option 4 — Refresh an existing token

If you already have a valid (non-expired) JWT, you can renew it:

```bash
NEW_JWT=$(curl -s -X POST http://localhost:3001/auth/refresh \
  -H "Authorization: Bearer $OLD_JWT" | jq -r .token)
```

`/auth/refresh` is a stateless renewal — it re-issues a new JWT with a fresh `exp` using
the same `sub` and `is_admin` from the existing token. No GitHub call required.

---

## Option 5 — Use the test-endpoints script (auto-obtains JWT)

```bash
QUORUM_GITHUB_TOKEN=$(gh auth token) node scripts/test-endpoints.js
```

The script calls `/auth/token` automatically and prints the sub/role once auth succeeds.

---

## Persistent JWT keys across container restarts

By default the gateway generates a **new ephemeral ES256 key pair on every start**.
To avoid token invalidation after rebuilds, set stable keys in `.env`:

```bash
# Generate once
node -e "
const { generateKeyPairSync } = require('crypto')
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
console.log('QUORUM_JWT_PRIVATE_KEY=' + Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))
console.log('QUORUM_JWT_PUBLIC_KEY='  + Buffer.from(publicKey.export({type:'spki',format:'pem'})).toString('base64'))
"
```

Add the output to `.env` (gitignored). The gateway will load them on startup instead of generating new ones.

---

## Why does my token expire after a rebuild?

When `QUORUM_JWT_PRIVATE_KEY` is not set, the gateway generates a fresh ES256 key pair in memory.
`verify-jwt.js` validates tokens using `getKeys().publicKey` — the in-memory key that was just generated.
Any token signed by a previous key pair fails verification.

This is intentional for security (no accidental key reuse) but inconvenient for dev.
Use persistent keys (Option 5 above) or the nginx `resolver` workaround for the dashboard.

---

## Decoding a JWT (inspect claims)

```bash
echo $JWT | cut -d. -f2 | base64 -d | jq .
```

In v0.3 the payload contains only: `{ sub, is_admin, iss, iat, exp, jti }`.
`project`, `role`, `team`, and `base_confidence` are **not in the token** — they come from the
Redis profile cache via the `X-Quorum-Project` header on each request.
