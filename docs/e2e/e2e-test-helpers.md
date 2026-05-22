# E2E Test Helpers

## Philosophy

We test **our code**. We do not test Graphiti, FalkorDB, Redis, S3, or DynamoDB.
If our code sends the right data to those libraries, they will do their job correctly.

Concretely:
- We assert that our gateway returns the right HTTP status and body shape.
- We assert that our constitutional rules fire at the right callsites.
- We assert that our PostgreSQL state transitions happen atomically.
- We do **not** assert embedding quality, similarity scores, cache TTLs, or graph
  index accuracy — those are the libraries' responsibilities.

This means **23 of 27 scenarios are pure HTTP/PostgreSQL tests** with no timing
dependencies. `graphitiSettle()` is only needed for the 4 scenarios that test
our code's write-then-read pipeline through Graphiti.

---

## Helper Files

```
tests/e2e/helpers/
  api.js        pre-configured HTTP client + constitutional assertion
  jwt.js        token generation + pre-built tokens for all 8 test users
  seed.js       prerequisite state creation (active entry, draft, conflict, deviation)
  graphiti.js   write-then-read timing delay
```

---

## `api.js`

Every scenario makes HTTP calls that need `Authorization` and `X-Quorum-Project`
headers. This helper eliminates that boilerplate at every callsite.

```javascript
import axios from 'axios'

const BASE = process.env.QUORUM_GATEWAY_URL || 'http://localhost:3001'

/**
 * Returns a pre-configured axios instance for the given bearer token and project.
 * validateStatus: () => true prevents axios from throwing on 4xx/5xx responses —
 * tests frequently assert on those status codes and need the response body.
 *
 * @param {string} bearerToken - Signed JWT for the test user
 * @param {string} [project='quorum-test-project'] - X-Quorum-Project header value
 * @returns {import('axios').AxiosInstance}
 */
export function api(bearerToken, project = 'quorum-test-project') {
  return axios.create({
    baseURL: BASE,
    headers: {
      Authorization:      `Bearer ${bearerToken}`,
      'X-Quorum-Project': project,
    },
    validateStatus: () => true,
  })
}

/**
 * Convenience: catalog-scoped client for federation scenarios (J01, S-02.x globals).
 *
 * @param {string} bearerToken
 */
export const catalogApi = (bearerToken) => api(bearerToken, 'quorum-test-catalog')

/**
 * Asserts that a response is a constitutional violation for the given rule.
 * Used wherever REASON_REQUIRED, NO_SELF_APPROVAL, GLOBAL_WRITE_AUTHORITY, etc. fire.
 * Saves repeating the same two-line assertion across ~30 callsites.
 *
 * @param {import('axios').AxiosResponse} res
 * @param {string} rule - e.g. 'REASON_REQUIRED', 'NO_SELF_APPROVAL'
 */
export function assertConstitutionalViolation(res, rule) {
  expect(res.status).toBe(400)
  expect(res.data.rule).toBe(rule)
}
```

**Usage:**
```javascript
import { api, assertConstitutionalViolation } from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'

const client = api(tokens.pe)
const res = await client.post('/api/knowledge/auth/token-strategy/promote', {
  note: 'tbd',
})
assertConstitutionalViolation(res, 'REASON_REQUIRED')
```

---

## `jwt.js`

Generates ES256 JWTs using the committed P-256 test key pair in
`tests/e2e/fixtures/`. Domain scenarios import `tokens` and use them directly
without any assertion about whether auth works — that was proven in `auth.spec.js`.

```javascript
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'

const __dir     = dirname(fileURLToPath(import.meta.url))
const PRIV_KEY  = readFileSync(resolve(__dir, '../fixtures/test-private-key.pem'))
const KEY_ID    = 'test-key-1'

/**
 * Signs a minimal ES256 JWT for the given subject using the committed test key.
 * The gateway's verify-jwt middleware will accept this token when configured
 * with QUORUM_JWT_PUBLIC_KEY from docker-compose.test.yml.
 *
 * @param {string} sub - GitHub username of the test user (e.g. 'test-pe')
 * @returns {string} Signed JWT
 */
export function token(sub) {
  return jwt.sign({ sub }, PRIV_KEY, {
    algorithm:  'ES256',
    expiresIn:  '1h',
    keyid:      KEY_ID,
  })
}

/**
 * Pre-built tokens for all 8 test users.
 * Import only what the scenario needs.
 *
 * Role mapping (from quorum-test-project.quorum.json):
 *   pa         → principal_architect  (writes land as ACTIVE, can approve)
 *   pe         → principal_engineer   (can promote, deprecate, supersede)
 *   architect  → architect            (can write to global catalogs)
 *   engineer   → engineer             (writes land as DRAFT)
 *   compliance → compliance_officer
 *   director   → director             (portfolio read-only)
 *   executive  → vp_engineering       (portfolio read-only)
 *   admin      → is_admin: true       (admin routes accessible)
 */
export const tokens = {
  pa:         token('test-pa'),
  pe:         token('test-pe'),
  architect:  token('test-architect'),
  engineer:   token('test-engineer'),
  compliance: token('test-compliance'),
  director:   token('test-director'),
  executive:  token('test-executive'),
  admin:      token('test-admin'),
}
```

---

## `seed.js`

Creates prerequisite state so each scenario tests its own concern rather than
re-implementing setup logic. All writes use `uid()` keys so state is isolated
between runs in PostgreSQL.

`activeEntry()` uses the PA token because PA writes land as ACTIVE in one call —
no promote step needed. This is the fastest way to get prerequisite ACTIVE state.

```javascript
import { api }             from './api.js'
import { tokens }          from './jwt.js'
import { graphitiSettle }  from './graphiti.js'

/**
 * Generates a unique key for each test run.
 * Ensures PostgreSQL isolation between runs without needing teardown.
 *
 * @param {string} prefix - Human-readable prefix (e.g. 'auth-strategy')
 * @returns {string} e.g. 'auth-strategy-1716400000000'
 */
export const uid = (prefix) => `${prefix}-${Date.now()}`

/**
 * Creates an ACTIVE knowledge entry using the PA token.
 * PA writes land as ACTIVE directly — no approval step required.
 * Use as prerequisite for scenarios that need an existing ACTIVE entry.
 *
 * @param {{ topic: string, key: string, content: string, entityType?: string }} opts
 * @returns {Promise<{ topic: string, key: string, versionId: string }>}
 */
export async function activeEntry({ topic, key, content, entityType = 'Decision' }) {
  const client = api(tokens.pa)
  const res = await client.post('/api/knowledge', {
    topic,
    key,
    content,
    entity_type: entityType,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.activeEntry failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { topic, key, versionId: res.data.version_id }
}

/**
 * Creates a DRAFT knowledge entry using the engineer token.
 * Use as prerequisite for scenarios that need a pending decision to act on.
 *
 * @param {{ topic: string, key: string, content: string, entityType?: string }} opts
 * @returns {Promise<{ topic: string, key: string, decisionId: string }>}
 */
export async function draftEntry({ topic, key, content, entityType = 'Decision' }) {
  const client = api(tokens.engineer)
  const res = await client.post('/api/knowledge', {
    topic,
    key,
    content,
    entity_type: entityType,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.draftEntry failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { topic, key, decisionId: res.data.decision_id }
}

/**
 * Creates a conflict (pending decision) by writing a semantically similar entry
 * against an existing ACTIVE entry.
 * Calls graphitiSettle() internally — callers do not need to manage timing.
 *
 * Use as prerequisite for scenarios that need a conflict_id to act on
 * (e.g. S-15 testing POST /api/review/:id with placeholder reasons).
 *
 * @param {{ topic: string, key: string, content: string }} opts - the conflicting content
 * @returns {Promise<{ conflictId: string }>}
 */
export async function conflict({ topic, key, content }) {
  const client = api(tokens.engineer)
  await client.post('/api/knowledge', { topic, key, content })
  await graphitiSettle()
  const pending = await client.get('/api/pending')
  const entry = pending.data.decisions?.find(
    d => d.topic === topic && d.key === key
  )
  if (!entry) throw new Error(`seed.conflict: no conflict found for ${topic}/${key}`)
  return { conflictId: entry.decision_id }
}

/**
 * Records a deviation against an entry in the global catalog.
 * Use as prerequisite for scenarios testing POST /api/deviations/:id/action.
 *
 * @param {{ catalogId: string, topic: string, key: string, description: string }} opts
 * @returns {Promise<{ deviationId: string }>}
 */
export async function deviation({ catalogId, topic, key, description }) {
  const client = api(tokens.pa)
  const res = await client.post('/api/deviations', {
    catalog_id:  catalogId,
    topic,
    key,
    description,
    source:      'test',
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.deviation failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { deviationId: res.data.deviation_id }
}
```

---

## `graphiti.js`

Only needed for scenarios that test our code's **write-then-read pipeline through
Graphiti**. These are exactly 4 of the 27 scenarios:

| Scenario | Why needed |
|----------|------------|
| S-01 Global Catalog Onboarding | Global write → cross-catalog search |
| S-02.1 Write + Recall | `remember()` → `recall()` reads from Graphiti |
| S-02.2 Conflict Detection | First write indexed → second write triggers searchNodes |
| S-06 Multi-User Conflict | Concurrent writes both need to be indexed before conflict check |

All other scenarios are pure HTTP/PostgreSQL and do not call `graphitiSettle()`.
`seed.conflict()` calls it internally, so its callers are also covered.

```javascript
/**
 * Waits for Graphiti/FalkorDB to finish indexing a freshly written node
 * before issuing a read (recall, search, or conflict detection).
 *
 * 5 seconds is conservative — revisit once timing behaviour under
 * mock-openai is understood.
 *
 * Do NOT call this in scenarios that do not read from Graphiti.
 * Do NOT call this after seed.conflict() — it calls this internally.
 */
export async function graphitiSettle() {
  await new Promise(r => setTimeout(r, 5_000))
}
```

---

## Non-Conflicting Test Data

Each scenario owns a semantically distinct domain so FalkorDB similarity search
never surfaces one scenario's entries as conflicts for another's.

```javascript
// tests/e2e/helpers/data.js
// Canonical topic domains per scenario — import and use uid() for unique keys.
export const DOMAINS = {
  'S-01':   'global-catalog-bootstrap',
  'S-02-1': 'circuit-breaker-payments',
  'S-02-2': 'retry-policy-downstream',
  'S-02-3': 'cache-invalidation-strategy',
  'S-02-4': 'connection-pool-sizing',
  'S-02-5': 'feature-flag-rollout',
  'S-02-6': 'event-sourcing-pattern',
  'S-02-7': 'saga-orchestration',
  'S-02-8': 'bulkhead-isolation',
  'S-03':   'deprecation-legacy-api',
  'S-04':   'db-migration-batch-jobs',
  'S-05':   'rbac-test-boundary',
  'S-06':   'concurrent-write-conflict',
  'S-07':   'rate-limiting-public-api',
  'S-08':   'confidence-bump-test',
  'S-09':   'admin-ops-test',
  'S-10':   'audit-chain-test',
  'S-11':   'self-approval-test',
  'S-12':   'state-machine-test',
  'S-13':   'config-governance-test',
  'S-14':   'dashboard-visual-test',
  'S-15':   'reason-placeholder-test',
  'S-16':   'knowledge-history-test',
}
```

---

## Scenario Helper Usage Reference

Which helpers each scenario needs at a glance.

| Scenario | `api` | `tokens` | `seed.*` | `graphitiSettle` |
|----------|-------|----------|----------|-----------------|
| L1 auth.spec.js | ✓ | ✓ | — | — |
| S-01 | ✓ | ✓ | — | ✓ |
| S-02.1 | ✓ | ✓ | — | ✓ |
| S-02.2 | ✓ | ✓ | `activeEntry` | ✓ (via seed.conflict) |
| S-02.3 | ✓ | ✓ | `activeEntry` | — |
| S-02.4 | ✓ | ✓ | `draftEntry` | — |
| S-02.5 | ✓ | ✓ | `draftEntry` | — |
| S-02.6 | ✓ | ✓ | `activeEntry` | — |
| S-02.7 | ✓ | ✓ | `activeEntry` | — |
| S-02.8 | ✓ | ✓ | `activeEntry` | — |
| S-03 | ✓ | ✓ | `activeEntry` | — |
| S-04 | ✓ | ✓ | `activeEntry` + `deviation` | — |
| S-05.1 | ✓ | ✓ (all roles) | — | — |
| S-05.2 | ✓ | ✓ | `draftEntry` | — |
| S-05.3 | ✓ | ✓ | `activeEntry` | — |
| S-05.4 | ✓ | ✓ | `activeEntry` + `draftEntry` | — |
| S-05.5 | ✓ | ✓ | `activeEntry` + `deviation` | — |
| S-05.6 | ✓ | ✓ | — | — |
| S-06 | ✓ | ✓ | `activeEntry` | ✓ (via seed.conflict) |
| S-07 | ✓ | ✓ | `activeEntry` × 10 + `deviation` | — |
| S-08 | ✓ | ✓ | `activeEntry` | — |
| S-09 | ✓ | ✓ (admin) | — | — |
| S-10 | ✓ | ✓ | `activeEntry` | — |
| S-11 | ✓ | ✓ | `draftEntry` | — |
| S-12 | ✓ | ✓ | `draftEntry` | — |
| S-13 | ✓ | ✓ (pa) | — | — |
| S-14 | ✓ | ✓ | `activeEntry` × 3 | — |
| S-15 | ✓ | ✓ | `activeEntry` + `draftEntry` + `conflict` + `deviation` | — (via seed.conflict) |
| S-16 | ✓ | ✓ (pa) | — | — |

> `graphitiSettle` is called **directly** only in S-01 and S-02.1.
> S-02.2, S-06, and S-15 use `seed.conflict()` which calls it internally.
> Every other scenario is a synchronous HTTP + PostgreSQL test.

---

## What Is Not a Helper

| Idea | Why not |
|------|---------|
| Teardown / cleanup functions | `uid()` keys isolate state; leftover rows do not affect other scenarios |
| Retry wrapper on API calls | `graphitiSettle()` handles the only timing concern; flaky tests should be fixed, not retried |
| Response schema validators | Two-line `expect` assertions are clear enough inline |
| Scenario context object | Adds indirection with no gain; `beforeAll` in each spec file is sufficient |
| Test lifecycle manager | Each spec file owns its own `beforeAll` / `afterAll` |

---

*Test infrastructure guide: [README.md](README.md)*
*Risk-weighted test plan and scenario weights: [../RISK_WEIGHTED_TEST_PLAN.md](../RISK_WEIGHTED_TEST_PLAN.md)*
