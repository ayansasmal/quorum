# J19 — Authentication Lifecycle & Boundary Enforcement

**Scenario ID:** S-19
**Weight:** 45 (15 raw leaves × F3)
**Blast radius:** 4.1% of suite
**Frequency tier:** F3 (daily — auth boundaries are security-critical and must run on every CI pass)
**Spec file:** `tests/e2e/scenarios/19-auth-lifecycle.spec.js`

---

## What It Covers

The complete authentication surface: JWT validation and rejection, algorithm enforcement (ES256 only —
never HS256), project-scoped role resolution, token refresh, PAT authentication, and the JWKS
endpoint contract. All other journeys assume a valid JWT exists — this journey tests what happens
at every invalid or boundary condition. A regression here breaks the entire auth chain.

**Security invariant:** Quorum uses ES256 (ECDSA P-256). A server that accepts HS256 tokens is
vulnerable to token forgery by any party that knows the secret (including any service that has
ever seen a legitimate token). This must be tested explicitly.

**Roles:** `test-pe` (valid PA), `test-engineer` (valid engineer), `test-admin` (is_admin: true)
**Touches:** All authenticated routes (sample: `GET /pg/versions/auth/any-key`), `GET /.well-known/jwks.json`, `POST /auth/refresh`, `GET /user/profile/:username`
**Automated:** Yes — API
**Manual tests:** GitHub OAuth browser flow (see MT-11), PKCE OAuth 2.1 end-to-end (see MT-12)

---

## Setup

```javascript
// Generate boundary-case JWTs using the test key pair (tests/helpers/jwt.js)
// All tokens use the real test EC private key unless noted otherwise

const validToken     = await generateToken({ sub: 'test-pe', is_admin: false })
const expiredToken   = await generateToken({ sub: 'test-pe', is_admin: false, exp: Math.floor(Date.now() / 1000) - 3600 })
const tamperedToken  = buildTamperedToken(validToken)  // change payload, keep original signature
const hs256Token     = await generateHs256Token({ sub: 'test-pe' }, 'any-secret')  // HMAC-SHA256
const unknownSubToken = await generateToken({ sub: 'no-such-user-s19', is_admin: false })
```

---

## Steps

### Part A — JWT Validation Boundaries

1. **Valid JWT → protected route succeeds:**
   - `GET /pg/versions/auth/any-key` with `Authorization: Bearer <validToken>`
   - Assert: `200` or `404` — the auth layer passes (HTTP 404 means key not found, auth did not block)
   - Assert: NOT `401`

2. **Missing Authorization header:**
   - `GET /pg/versions/auth/any-key` with no Authorization header
   - Assert: `401` with descriptive error

3. **Expired JWT:**
   - `GET /pg/versions/auth/any-key` with `Authorization: Bearer <expiredToken>`
   - Assert: `401` — expired token must be rejected, not accepted with stale claims

4. **Tampered JWT (modified payload, original signature):**
   - `GET /pg/versions/auth/any-key` with `Authorization: Bearer <tamperedToken>`
   - Assert: `401` — signature validation must catch the modification

5. **HS256-signed JWT (wrong algorithm):**
   - `GET /pg/versions/auth/any-key` with `Authorization: Bearer <hs256Token>`
   - Assert: `401` — gateway must reject any JWT not signed with ES256 (ECDSA P-256)
   - Assert: response does NOT indicate what algorithm was expected (avoid leaking algorithm details)

6. **Valid JWT but unknown sub (user not in DDB):**
   - `GET /pg/versions/auth/any-key` with `Authorization: Bearer <unknownSubToken>`
   - Assert: `401` — profile lookup for `no-such-user-s19` fails, auth chain stops

---

### Part B — JWKS Endpoint Structure

> The JWKS endpoint is public (no auth required) and serves the public key for ES256
> verification. MCP clients and external verifiers use it to validate tokens issued by the gateway.

7. `GET /.well-known/jwks.json` (no Authorization header):
   - Assert: `200`
   - Assert: response has `keys` array with at least one entry

8. Assert key structure:
   - `keys[0].kty === "EC"` (Elliptic Curve key, not RSA)
   - `keys[0].alg === "ES256"` or `keys[0].crv === "P-256"` (correct curve)
   - `keys[0].use === "sig"` (signing key, not encryption)
   - `keys[0].kid` is present (key ID for rotation support)
   - No key with `alg: "HS256"` or `kty: "RSA"` present in the `keys` array

---

### Part C — Project-Scoped Role Resolution

> The `X-Quorum-Project` header determines which project's role the JWT is resolved against.
> Role is per-project — a PA in project A may be an engineer in project B.

9. Valid `test-pe` JWT + `X-Quorum-Project: quorum-test-project` (member project):
   - `GET /api/knowledge?limit=1` — any project-scoped route
   - Assert: `200`, `req.user.role` resolved (no 401/403 from role resolution)

10. Valid `test-pe` JWT + `X-Quorum-Project: project-test-pe-is-not-a-member-s19`
    (a project ID this user is not a member of):
    - Assert: `403` or `404` — gateway must refuse access when user is not a member

11. Valid `test-pe` JWT + missing `X-Quorum-Project` on a project-scoped route:
    - `GET /api/knowledge` with no `X-Quorum-Project` header
    - Assert: `400` with `error: "missing_header"` or equivalent (project context required)

---

### Part D — Token Refresh

12. `POST /auth/refresh` with a valid, unexpired refresh token (issued during test setup or
    by calling `POST /auth/token` first with the GitHub OAuth mock):
    - Assert: `200`, new access JWT returned
    - Assert: new JWT is parseable and has `sub` matching the original user
    - Assert: new JWT `exp` is in the future

13. `POST /auth/refresh` with an expired or fabricated refresh token:
    - Assert: `401` — expired refresh tokens must not yield new access tokens

---

### Part E — PAT (Personal Access Token) Authentication

> PATs allow CI agents and MCP servers to authenticate without browser-based GitHub OAuth.
> The gateway accepts PATs in the Authorization header as an alternative to JWT.

14. `GET /pg/versions/auth/any-key` with `Authorization: Bearer <validPAT>`:
    - (PAT provisioned during test setup via the admin API or seeded directly in the DB)
    - Assert: `200` or `404` — PAT authentication succeeds
    - Assert: NOT `401`

15. `GET /pg/versions/auth/any-key` with `Authorization: Bearer invalidpat-not-a-real-token`:
    - Assert: `401` — invalid PAT rejected before reaching protected resources

---

## Pass Criteria

- [ ] Valid JWT → authenticated (200 or 404 from the resource, not 401)
- [ ] Missing Authorization header → `401`
- [ ] Expired JWT → `401` (not silently accepted)
- [ ] Tampered JWT (payload modified, signature unchanged) → `401`
- [ ] HS256-signed JWT → `401` — gateway never accepts non-ES256 tokens
- [ ] JWT with unknown `sub` (user not in DDB) → `401`
- [ ] `GET /.well-known/jwks.json` → `200` with valid JWKS structure
- [ ] JWKS contains EC/P-256 key with `alg: "ES256"`, `use: "sig"`, and `kid` present
- [ ] JWKS does NOT contain any HS256 or RSA key
- [ ] Member project access → `200`, role resolved
- [ ] Non-member project → `403` or `404`
- [ ] Missing `X-Quorum-Project` on project-scoped route → `400 missing_header`
- [ ] Valid refresh token → new access JWT issued with future expiry
- [ ] Expired refresh token → `401`
- [ ] Valid PAT → authenticated
- [ ] Invalid PAT → `401`

---

## Teardown

No persistent knowledge entries created. Test JWTs are ephemeral — no cleanup needed.

---

## Manual Tests

| Test | Why manual | ID |
|------|------------|-----|
| GitHub OAuth browser flow | Requires a real GitHub OAuth callback — cannot be simulated in API tests without a browser driver and GitHub mock | MT-11 |
| PKCE OAuth 2.1 end-to-end (MCP client) | Requires an actual MCP client session via stdio — `mcp-oauth.js` implements RFC 8414 discovery + PKCE flow; no HTTP equivalent | MT-12 |

---

## Related Scenarios

- **S-05** (RBAC) — assumes valid JWT; this scenario tests what happens when the JWT itself is invalid
- **S-09** (Admin operations) — `is_admin: true` JWT tested; this scenario tests the validation of those JWTs
- **S-11** (Self-approval) — the `sub` claim comparison used in self-approval prevention relies on auth working correctly
