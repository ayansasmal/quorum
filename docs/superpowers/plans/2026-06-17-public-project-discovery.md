# Public Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any authenticated GitHub user (member or not) discover and browse `is_public: true` projects read-only, with zero ability to perform writes against them.

**Architecture:** Mirror the existing `is_global` plumbing in `q_projects` (migration column, two `config.js` sync call sites, `sync.js` batch re-affirmation) for a new `is_public` column; add a new `GET /api/public-projects` route with the same shape as `GET /api/globals` but no hierarchy scoping; merge its results into the dashboard's `completeOAuth()` project list as `role: null` / `is_guest: true` entries so the dashboard's existing guest-gating (`isGuest`, `MemberRoute`, `requireMembership`) engages automatically with no new RBAC code.

**Tech Stack:** Node.js/Express gateway, PostgreSQL (`pg.Pool`), vitest (gateway unit tests), Playwright (E2E API + browser), React 19 dashboard SPA.

This plan spans **two independent git repositories**:
- **`quorum`** (this repo) — Tasks 1–7 (migration, gateway routes, gateway unit tests, E2E API scenario)
- **`quorum-dash`** (sibling repo, path `../quorum-dash` from this repo's root) — Tasks 8–11 (AuthContext merge, UI guest gates, E2E browser scenario)

Commit each repo's changes separately — they have separate CLAUDE.md files and separate git histories. Do not mix `quorum` and `quorum-dash` file changes into the same commit.

---

## Part 1 — `quorum` repo (backend)

### Task 1: Postgres migration — `is_public` column on `q_projects`

**Files:**
- Modify: `helm/quorum/files/init-db.sql:24-43` (table definition), `helm/quorum/files/init-db.sql:48-59` (migration guard block), `helm/quorum/files/init-db.sql:481-482` (GRANT statement)

This file has no automated test runner (it's applied by Postgres at container init / via the migration guard on every gateway boot). Verification is by direct `psql`/`docker exec` inspection, not vitest.

- [ ] **Step 1: Add `is_public` to the `q_projects` table definition**

In `helm/quorum/files/init-db.sql`, the table definition currently ends:

```sql
  is_global BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
```

Change to:

```sql
  is_global BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
```

- [ ] **Step 2: Add the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration guard**

Immediately after the existing guard line:

```sql
ALTER TABLE q_projects ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT FALSE;
```

add:

```sql
ALTER TABLE q_projects ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
```

- [ ] **Step 3: Add the partial index**

Immediately after the existing index line:

```sql
CREATE INDEX IF NOT EXISTS idx_qp_is_global ON q_projects (is_global) WHERE is_global = TRUE;
```

add:

```sql
CREATE INDEX IF NOT EXISTS idx_qp_is_public ON q_projects (is_public) WHERE is_public = TRUE;
```

- [ ] **Step 4: Add `is_public` to the column-level UPDATE grant**

Change:

```sql
GRANT UPDATE (members, domains, governance, display_name, owner, config_version, is_global)
  ON q_projects TO quorum_app;
```

to:

```sql
GRANT UPDATE (members, domains, governance, display_name, owner, config_version, is_global, is_public)
  ON q_projects TO quorum_app;
```

- [ ] **Step 5: Verify against a local Postgres**

Run (from `quorum/`, with the dev stack up — `npm run docker:start` if not already running):

```bash
docker exec -i $(docker compose ps -q postgres) psql -U quorum_app -d quorum -c "\d q_projects" | grep is_public
```

Expected output contains a line showing `is_public | boolean | not null default false`.

If the dev Postgres container was created before this change, the guard statements only run on next container init, not on an already-initialized volume. If the column does not appear, apply the two `ALTER TABLE`/`CREATE INDEX` statements manually against the running container:

```bash
docker exec -i $(docker compose ps -q postgres) psql -U quorum_app -d quorum -c \
  "ALTER TABLE q_projects ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE; CREATE INDEX IF NOT EXISTS idx_qp_is_public ON q_projects (is_public) WHERE is_public = TRUE; GRANT UPDATE (members, domains, governance, display_name, owner, config_version, is_global, is_public) ON q_projects TO quorum_app;"
```

- [ ] **Step 6: Commit**

```bash
git add helm/quorum/files/init-db.sql
git commit -m "feat(db): add is_public column to q_projects"
```

---

### Task 2: `createProject()` accepts `isPublic`

**Files:**
- Modify: `gateway/src/shared/graph/queries.js:55-78`
- Test: `tests/gateway/queries.test.js:64-80`

- [ ] **Step 1: Write the failing test**

In `tests/gateway/queries.test.js`, inside the existing `describe('createProject', ...)` block (after the `'inserts into q_projects and returns q_project_id'` test, still inside the same `describe`), add:

```javascript
  it('passes opts.isPublic through to the INSERT params and SQL', async () => {
    const pool = makePool(
      { rows: [{ n: 8 }] },                     // SELECT nextval
      { rows: [{ q_project_id: 'q_p8' }] },     // INSERT RETURNING
    )
    await createProject(pool, 'my-group', 'alice', [], {}, { isPublic: true })

    const insertCall = pool.query.mock.calls[1]
    expect(insertCall[0]).toContain('is_public')
    expect(insertCall[1][insertCall[1].length - 1]).toBe(true)
  })

  it('defaults isPublic to false when opts.isPublic is omitted', async () => {
    const pool = makePool(
      { rows: [{ n: 9 }] },
      { rows: [{ q_project_id: 'q_p9' }] },
    )
    await createProject(pool, 'my-group', 'alice', [], {}, {})

    const insertCall = pool.query.mock.calls[1]
    expect(insertCall[1][insertCall[1].length - 1]).toBe(false)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gateway/queries.test.js -t "isPublic"`
Expected: FAIL — `insertCall[0]` does not contain `'is_public'` (current SQL has 9 `$n` placeholders ending at `is_global`).

- [ ] **Step 3: Write minimal implementation**

In `gateway/src/shared/graph/queries.js:55-78`, change:

```javascript
export async function createProject(pg, groupId, owner, members = [], governance = {}, opts = {}) {
  if (typeof pg.createProject === 'function') {
    return pg.createProject(groupId, owner, members, governance, opts)
  }
  const seq = await pg.query(`SELECT nextval('q_project_seq') AS n`)
  const qProjectId = `q_p${seq.rows[0].n}`
  const { rows } = await pg.query(
    `INSERT INTO q_projects (q_project_id, group_id, display_name, owner, members, domains, governance, created_by, is_global)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING q_project_id`,
    [
      qProjectId, groupId, opts.displayName ?? null, owner,
      JSON.stringify(members), JSON.stringify(opts.domains ?? []),
      JSON.stringify(governance), opts.createdBy ?? owner, opts.isGlobal ?? false,
    ],
  )
  return rows[0].q_project_id
}
```

to:

```javascript
export async function createProject(pg, groupId, owner, members = [], governance = {}, opts = {}) {
  if (typeof pg.createProject === 'function') {
    return pg.createProject(groupId, owner, members, governance, opts)
  }
  const seq = await pg.query(`SELECT nextval('q_project_seq') AS n`)
  const qProjectId = `q_p${seq.rows[0].n}`
  const { rows } = await pg.query(
    `INSERT INTO q_projects (q_project_id, group_id, display_name, owner, members, domains, governance, created_by, is_global, is_public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING q_project_id`,
    [
      qProjectId, groupId, opts.displayName ?? null, owner,
      JSON.stringify(members), JSON.stringify(opts.domains ?? []),
      JSON.stringify(governance), opts.createdBy ?? owner, opts.isGlobal ?? false,
      opts.isPublic ?? false,
    ],
  )
  return rows[0].q_project_id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gateway/queries.test.js -t "isPublic"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full queries test file to check for regressions**

Run: `npx vitest run tests/gateway/queries.test.js`
Expected: all tests PASS (the duck-typing shortcut test and the original insert test both call `createProject` with fewer/no `opts.isPublic` — they must still pass since `opts.isPublic ?? false` defaults safely)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/shared/graph/queries.js tests/gateway/queries.test.js
git commit -m "feat(gateway): createProject persists is_public"
```

---

### Task 3: `config.js` — `is_public` on create + re-affirmation

**Files:**
- Modify: `gateway/src/routes/config.js:185-213` (POST `/config/upload`), `gateway/src/routes/config.js:281-301` (PUT `/:projectId`)
- Test: `tests/gateway/config-routes.test.js` (new tests inside `describe('POST /config/upload', ...)` at line 286, and inside the existing PUT re-registration test block ending at line 434)

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/config-routes.test.js`, inside the `describe('POST /config/upload', ...)` block, after the existing `'updates an existing config through PUT and re-registers a missing project row'` test (just before the closing `})` of the describe block, i.e. before line 434), add:

```javascript
  it('passes is_public through to createProject on new project registration', async () => {
    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    syncOneProject.mockResolvedValue({ ok: true })

    const config = {
      group_id: 'public-new-project',
      owner:    'alice',
      members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
      is_public: true,
    }

    const { status } = await post(
      '/config/upload',
      config,
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )

    expect(status).toBe(201)
    expect(createProject).toHaveBeenCalledWith(
      app.locals.pool,
      'public-new-project',
      'alice',
      config.members,
      { domains: {} },
      expect.objectContaining({ isPublic: true }),
    )
  })

  it('re-affirms is_public on an existing project row when re-uploading a public config', async () => {
    getProjectByGroupId.mockResolvedValueOnce('q_p_existing')

    const config = {
      group_id: 'reaffirm-public-project',
      owner:    'alice',
      members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
      is_public: true,
    }

    const { status } = await post(
      '/config/upload',
      config,
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )

    expect(status).toBe(201)
    expect(app.locals.pool.query).toHaveBeenCalledWith(
      expect.stringContaining('is_public'),
      ['reaffirm-public-project'],
    )
  })
```

In the same file's `describe('POST /config/upload', ...)` block, modify the existing PUT re-registration test (`'updates an existing config through PUT and re-registers a missing project row'`, lines 406-433) to also assert `isPublic` is passed through on the create-only path. Change:

```javascript
  it('updates an existing config through PUT and re-registers a missing project row', async () => {
    mockProfile('alice', 'new-project', 'principal_architect')
    getProjectByGroupId.mockResolvedValueOnce(null)
    createProject.mockResolvedValueOnce('q_recreated')
    const tok = await makeToken('alice')

    const { status, body } = await put(
      '/config/new-project',
      VALID_CONFIG,
      {
        Authorization:      `Bearer ${tok}`,
        'X-Quorum-Project': 'new-project',
      },
    )

    expect(status).toBe(200)
    expect(body.q_project_id).toBe('q_recreated')
    expect(createProject).toHaveBeenCalledWith(
      app.locals.pool,
      'new-project',
      'alice',
      VALID_CONFIG.members,
      { domains: {} },
      expect.objectContaining({ createdBy: 'alice' }),
    )
    // Membership edits via PUT must also bust affected profile caches.
    expect(invalidateProfile).toHaveBeenCalledWith('alice')
  })
```

to:

```javascript
  it('updates an existing config through PUT and re-registers a missing project row', async () => {
    mockProfile('alice', 'new-project', 'principal_architect')
    getProjectByGroupId.mockResolvedValueOnce(null)
    createProject.mockResolvedValueOnce('q_recreated')
    const tok = await makeToken('alice')

    const { status, body } = await put(
      '/config/new-project',
      VALID_CONFIG,
      {
        Authorization:      `Bearer ${tok}`,
        'X-Quorum-Project': 'new-project',
      },
    )

    expect(status).toBe(200)
    expect(body.q_project_id).toBe('q_recreated')
    expect(createProject).toHaveBeenCalledWith(
      app.locals.pool,
      'new-project',
      'alice',
      VALID_CONFIG.members,
      { domains: {} },
      expect.objectContaining({ createdBy: 'alice', isPublic: false }),
    )
    // Membership edits via PUT must also bust affected profile caches.
    expect(invalidateProfile).toHaveBeenCalledWith('alice')
  })

  it('passes is_public through to createProject when PUT re-registers a missing project row', async () => {
    mockProfile('alice', 'public-put-project', 'principal_architect')
    getProjectByGroupId.mockResolvedValueOnce(null)
    createProject.mockResolvedValueOnce('q_recreated_public')
    const tok = await makeToken('alice')

    const config = {
      group_id: 'public-put-project',
      owner:    'alice',
      members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
      is_public: true,
    }

    const { status } = await put(
      '/config/public-put-project',
      config,
      {
        Authorization:      `Bearer ${tok}`,
        'X-Quorum-Project': 'public-put-project',
      },
    )

    expect(status).toBe(200)
    expect(createProject).toHaveBeenCalledWith(
      app.locals.pool,
      'public-put-project',
      'alice',
      config.members,
      { domains: {} },
      expect.objectContaining({ isPublic: true }),
    )
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gateway/config-routes.test.js -t "is_public"`
Expected: FAIL — `createProject` is currently called with `isGlobal` but not `isPublic`; the re-affirmation test fails because no `UPDATE ... is_public` query is ever issued.

- [ ] **Step 3: Write minimal implementation — POST `/config/upload`**

In `gateway/src/routes/config.js:185-213`, the current block is:

```javascript
    const pool = req.app.locals.pool
    let qProjectId = null
    try {
      qProjectId = await getProjectByGroupId(pool, groupId)
      if (!qProjectId) {
        qProjectId = await createProject(
          pool, groupId, config.owner, config.members ?? [], { domains: config.domains },
          { displayName: config.project ?? null, createdBy: req.user?.sub ?? 'system', isGlobal: config.is_global ?? false },
        )
      } else if (config.is_global === true) {
        await pool.query(`UPDATE q_projects SET is_global = true WHERE group_id = $1`, [groupId])
      }
    } catch (err) {
```

Change to:

```javascript
    const pool = req.app.locals.pool
    let qProjectId = null
    try {
      qProjectId = await getProjectByGroupId(pool, groupId)
      if (!qProjectId) {
        qProjectId = await createProject(
          pool, groupId, config.owner, config.members ?? [], { domains: config.domains },
          {
            displayName: config.project ?? null,
            createdBy:   req.user?.sub ?? 'system',
            isGlobal:    config.is_global ?? false,
            isPublic:    config.is_public ?? false,
          },
        )
      } else {
        if (config.is_global === true) {
          await pool.query(`UPDATE q_projects SET is_global = true WHERE group_id = $1`, [groupId])
        }
        if (config.is_public === true) {
          await pool.query(`UPDATE q_projects SET is_public = true WHERE group_id = $1`, [groupId])
        }
      }
    } catch (err) {
```

- [ ] **Step 4: Write minimal implementation — PUT `/:projectId`**

In `gateway/src/routes/config.js:281-301`, the current block is:

```javascript
    let qProjectId = await getProjectByGroupId(pool, projectId).catch(() => null)
    if (!qProjectId) {
      try {
        qProjectId = await createProject(
          pool, projectId, config.owner, config.members ?? [], { domains: config.domains },
          { displayName: config.project ?? null, createdBy: req.user.sub, isGlobal: config.is_global ?? false },
        )
      } catch (err) {
```

Change to:

```javascript
    let qProjectId = await getProjectByGroupId(pool, projectId).catch(() => null)
    if (!qProjectId) {
      try {
        qProjectId = await createProject(
          pool, projectId, config.owner, config.members ?? [], { domains: config.domains },
          {
            displayName: config.project ?? null,
            createdBy:   req.user.sub,
            isGlobal:    config.is_global ?? false,
            isPublic:    config.is_public ?? false,
          },
        )
      } catch (err) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/gateway/config-routes.test.js`
Expected: all PASS, including the 3 new tests and the modified PUT test.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/routes/config.js tests/gateway/config-routes.test.js
git commit -m "feat(gateway): sync is_public through config upload and PUT routes"
```

---

### Task 4: `sync.js` — `is_public` batch re-affirmation in `syncAllConfigs()`

**Files:**
- Modify: `gateway/src/routes/sync.js:244-256`
- Test: `tests/gateway/sync-globals.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/gateway/sync-globals.test.js`, after the closing `})` of `describe('syncAllConfigs — cross-catalog globals_warnings', ...)` (line 231), add a new top-level describe block:

```javascript
describe('syncAllConfigs — q_projects.is_public batch update', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('updates is_public for projects whose synced config has is_public: true', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return s3List(['public-project'])
      }
      return s3Body({ group_id: 'public-project', owner: 'alice', is_public: true })
    }

    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { syncAllConfigs } = await import('../../gateway/src/routes/sync.js')
    await syncAllConfigs(pool)
    delete process.env.QUORUM_CONFIG_BUCKET

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('is_public = true'),
      [['public-project']],
    )
  })

  it('does not issue an is_public update when no synced config has is_public: true', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return s3List(['private-project'])
      }
      return s3Body({ group_id: 'private-project', owner: 'alice' })
    }

    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { syncAllConfigs } = await import('../../gateway/src/routes/sync.js')
    await syncAllConfigs(pool)
    delete process.env.QUORUM_CONFIG_BUCKET

    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('is_public = true'),
      expect.anything(),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gateway/sync-globals.test.js -t "is_public batch update"`
Expected: FAIL — `pool.query` is never called with an `is_public` string (no such code path exists yet).

- [ ] **Step 3: Write minimal implementation**

In `gateway/src/routes/sync.js:244-256`, the current block is:

```javascript
    if (pool) {
      const globalIds = results
        .filter((r) => r.ok && r.config?.is_global === true)
        .map((r) => r.config.group_id ?? r.project_id)
      if (globalIds.length > 0) {
        await pool.query(`UPDATE q_projects SET is_global = true WHERE group_id = ANY($1)`, [globalIds])
          .catch((err) => console.error(`[Gateway] syncAllConfigs: q_projects is_global update failed — ${err.message}`))
      }
    }
    return { synced, failed, globals_warnings: globalsWarnings, duration_ms: Date.now() - startedAt }
```

Change to:

```javascript
    if (pool) {
      const globalIds = results
        .filter((r) => r.ok && r.config?.is_global === true)
        .map((r) => r.config.group_id ?? r.project_id)
      if (globalIds.length > 0) {
        await pool.query(`UPDATE q_projects SET is_global = true WHERE group_id = ANY($1)`, [globalIds])
          .catch((err) => console.error(`[Gateway] syncAllConfigs: q_projects is_global update failed — ${err.message}`))
      }

      const publicIds = results
        .filter((r) => r.ok && r.config?.is_public === true)
        .map((r) => r.config.group_id ?? r.project_id)
      if (publicIds.length > 0) {
        await pool.query(`UPDATE q_projects SET is_public = true WHERE group_id = ANY($1)`, [publicIds])
          .catch((err) => console.error(`[Gateway] syncAllConfigs: q_projects is_public update failed — ${err.message}`))
      }
    }
    return { synced, failed, globals_warnings: globalsWarnings, duration_ms: Date.now() - startedAt }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gateway/sync-globals.test.js`
Expected: all PASS (including the 2 new tests and all pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/routes/sync.js tests/gateway/sync-globals.test.js
git commit -m "feat(gateway): batch-update is_public in syncAllConfigs"
```

---

### Task 5: New route `GET /api/public-projects`

**Files:**
- Modify: `gateway/src/routes/dashboard.js:2448-2450` (insert before `export default router`)
- Test: Create `tests/gateway/dashboard-public-projects.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/dashboard-public-projects.test.js`:

```javascript
/**
 * GET /api/public-projects — discoverable is_public: true projects.
 *
 * Covers:
 *  - Empty result when no public projects exist
 *  - Full shape of returned rows
 *  - display_name falls back to group_id when null
 *  - Reachable even when req.user.project is null (no project selected yet)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => { req.user = req._mockUser ?? { sub: 'alice', project: 'payments-service', role: 'engineer', is_admin: false }; next() },
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn().mockResolvedValue('q_p1'),
}))

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile: vi.fn().mockResolvedValue({
    github_username: 'alice',
    is_admin: false,
    projects: [{ group_id: 'payments-service', role: 'engineer', base_confidence: 0.7, is_owner: false }],
  }),
  loadProjectConfig: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal pg pool mock that returns given rows for the is_public query.
 * @param {Array<{q_project_id: string, group_id: string, display_name?: string|null, owner?: string}>} publicRows
 */
function makePool(publicRows) {
  return {
    query: vi.fn().mockImplementation((sql) => {
      if (/is_public/i.test(sql)) return Promise.resolve({ rows: publicRows })
      return Promise.resolve({ rows: [] })
    }),
  }
}

/**
 * GET /api/public-projects using the given pool attached to app.locals.
 * @param {object} pool
 * @param {string|null} [project]
 */
async function getPublicProjects(pool, project = null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { sub: 'alice', project, role: project ? 'engineer' : null, is_admin: false }
    req.app.locals.pool = pool
    next()
  })
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  app.use('/api', dashboardRouter)
  const srv = http.createServer(app)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/api/public-projects`
  const res = await fetch(url)
  await new Promise((r) => srv.close(r))
  return { status: res.status, body: await res.json() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/public-projects — empty state', () => {
  it('returns an empty array when no public projects exist', async () => {
    const { status, body } = await getPublicProjects(makePool([]), 'payments-service')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

describe('GET /api/public-projects — populated', () => {
  it('returns the full shape for each public project row', async () => {
    const { status, body } = await getPublicProjects(makePool([
      { q_project_id: 'q_p5', group_id: 'ayan-portfolio', display_name: 'Ayan Portfolio', owner: 'ayan' },
    ]), 'payments-service')

    expect(status).toBe(200)
    expect(body).toEqual([
      { q_project_id: 'q_p5', group_id: 'ayan-portfolio', display_name: 'Ayan Portfolio', owner: 'ayan' },
    ])
  })

  it('falls back to group_id when display_name is null', async () => {
    const { body } = await getPublicProjects(makePool([
      { q_project_id: 'q_p6', group_id: 'no-display-name', display_name: null, owner: 'bob' },
    ]), 'payments-service')

    expect(body[0].display_name).toBe('no-display-name')
  })
})

describe('GET /api/public-projects — zero-project caller', () => {
  it('is reachable when req.user.project is null', async () => {
    const { status, body } = await getPublicProjects(makePool([
      { q_project_id: 'q_p5', group_id: 'ayan-portfolio', display_name: 'Ayan Portfolio', owner: 'ayan' },
    ]), null)

    expect(status).toBe(200)
    expect(body).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gateway/dashboard-public-projects.test.js`
Expected: FAIL with 404 (route doesn't exist yet — Express has no handler for `GET /api/public-projects`).

- [ ] **Step 3: Write minimal implementation**

In `gateway/src/routes/dashboard.js`, immediately before the final `export default router` (currently at line 2450, directly after the portfolio rollup route's closing `})` at line 2448), insert:

```javascript
/**
 * GET /api/public-projects — discover projects marked is_public: true.
 *
 * Authenticated via the standard JWT middleware (server.js); does not require
 * X-Quorum-Project and does not consult req.user.project, so it is reachable
 * even for a brand-new user with zero memberships. Unlike GET /api/globals,
 * this route applies no hierarchy/global_scope filtering — any is_public
 * project is visible to every authenticated user (see design spec's "Out of
 * Scope" section).
 *
 * E2E: tests/e2e/scenarios/23-self-serve-onboarding.spec.js — S-23.4 public project discovery
 */
router.get('/public-projects', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool
    const { rows } = await pool.query(
      `SELECT q_project_id, group_id, display_name, owner
         FROM q_projects
        WHERE is_public = TRUE
        ORDER BY group_id`,
    )
    res.json(rows.map((row) => ({
      q_project_id: row.q_project_id,
      group_id:     row.group_id,
      display_name: row.display_name ?? row.group_id,
      owner:        row.owner,
    })))
  } catch (err) {
    next(err)
  }
})

export default router
```

(Remove the old standalone `export default router` line that previously terminated the file — the new route must be the last thing before it, exactly as shown above with `export default router` retained directly after it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gateway/dashboard-public-projects.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full gateway test suite to check for regressions**

Run: `npm test --workspace=gateway` (or from `quorum/`: `npx vitest run tests/gateway/`)
Expected: all PASS, including `dashboard-globals.test.js` (unaffected — different route).

- [ ] **Step 6: Commit**

```bash
git add gateway/src/routes/dashboard.js tests/gateway/dashboard-public-projects.test.js
git commit -m "feat(gateway): add GET /api/public-projects route"
```

---

### Task 6: Update OpenAPI spec

**Files:**
- Modify: `gateway/openapi.yaml`

- [ ] **Step 1: Add the new path**

Find the `/api/globals` path entry in `gateway/openapi.yaml` (it is the structural template for this addition — same response shape pattern, no query parameters beyond auth headers). Add a new sibling path entry:

```yaml
  /api/public-projects:
    get:
      summary: Discover projects marked is_public
      description: >
        Returns every project with is_public = true. Authenticated via standard
        JWT; does not require X-Quorum-Project. No hierarchy/global_scope
        filtering is applied — every is_public project is visible to every
        authenticated user.
      tags: [dashboard]
      security:
        - bearerAuth: []
      responses:
        '200':
          description: List of public projects
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    q_project_id:
                      type: string
                    group_id:
                      type: string
                    display_name:
                      type: string
                    owner:
                      type: string
        '401':
          description: Missing or invalid JWT
```

- [ ] **Step 2: Validate the spec**

Run: `npx @redocly/cli lint gateway/openapi.yaml` (or whatever OpenAPI lint command is already configured in `package.json` — check `npm run` output for an existing `lint:openapi`-style script; if none exists, skip automated validation and visually confirm YAML indentation matches the surrounding `/api/globals` block).

- [ ] **Step 3: Commit**

```bash
git add gateway/openapi.yaml
git commit -m "docs(gateway): document GET /api/public-projects in OpenAPI spec"
```

---

### Task 7: E2E API sub-scenario `S-23.4`

**Files:**
- Modify: `tests/e2e/scenarios/23-self-serve-onboarding.spec.js` (append after line 122, the closing `})` of the existing `S-23.2` describe block)

This scenario reuses the `PROJECT` constant (module-scoped, `uid('s23-self-serve')`) already created with `is_public: true` by the `S-23.1` block earlier in the same file, and relies on `test.describe.configure({ mode: 'serial' })` (already set at the top of the file) to guarantee ordering.

- [ ] **Step 1: Write the new scenario**

Append to the end of `tests/e2e/scenarios/23-self-serve-onboarding.spec.js`, directly after the closing `})` of the `S-23.2` describe block:

```javascript

describe('S-23.4 — Public projects are discoverable by non-members', () => {
  test('a fresh authenticated outsider sees the public project in GET /api/public-projects', async () => {
    const discovererJwt = token('s23-discoverer')

    const res = await client(discovererJwt).get('/api/public-projects')

    expect(res.status).toBe(200)
    expect(res.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ group_id: PROJECT }),
    ]))
  })

  test('the same outsider still gets 403 on a mutating route against the public project', async () => {
    const discovererJwt = token('s23-discoverer')

    const res = await client(discovererJwt, PROJECT).post('/api/knowledge', {
      domain: 'test', key: uid('outsider-write'), entity_type: 'Decision',
      content: 'an outsider should not be able to write this',
    })

    expect(res.status).toBe(403)
    expect(res.data.error).toBe('not_a_member')
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

This requires the E2E test stack running. From `quorum/`:

```bash
npm run test:e2e:env:setup   # if not already up
npx playwright test tests/e2e/scenarios/23-self-serve-onboarding.spec.js
```

Expected: all tests in the file PASS, including the two new `S-23.4` tests. (`S-23.1` must run first in the same file to create `PROJECT` with `is_public: true` — `test.describe.configure({ mode: 'serial' })` already guarantees this within one file.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/scenarios/23-self-serve-onboarding.spec.js
git commit -m "test(e2e): add S-23.4 public project discovery scenario"
```

---

## Part 2 — `quorum-dash` repo (frontend)

> All paths below are relative to the `quorum-dash` repo root (sibling directory to `quorum`, i.e. `../quorum-dash` from this repo). Commit these changes in `quorum-dash`'s own git history — never combine with Part 1's commits.

### Task 8: `AuthContext.jsx` — merge public projects into `completeOAuth()`

**Files:**
- Modify: `src/context/AuthContext.jsx:115-125` (add `fetchPublicProjects` next to `fetchProfile`), `src/context/AuthContext.jsx:310-368` (`completeOAuth()`)

quorum-dash has no frontend unit test framework (Playwright E2E only — see CLAUDE.md). This merge logic is verified by the new browser E2E sub-scenario in Task 11, not by a unit test. Treat this task's steps as implement-then-manually-verify via the dev server, followed by the E2E scenario in Task 11 as the durable regression check.

- [ ] **Step 1: Add `fetchPublicProjects` helper**

In `src/context/AuthContext.jsx`, immediately after the existing `fetchProfile` function (lines 115-125):

```javascript
/**
 * Fetch the list of is_public: true projects from the gateway. Returns an
 * empty array on failure so a transient error never blocks login — the user
 * still sees their membership-based projects.
 * @param {string} jwt
 * @returns {Promise<object[]>}
 */
async function fetchPublicProjects(jwt) {
  try {
    const res = await fetch('/api/public-projects', {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}
```

- [ ] **Step 2: Merge public projects into the profile-fetch step of `completeOAuth()`**

In `src/context/AuthContext.jsx:310-368`, the current block is:

```javascript
  const completeOAuth = useCallback(async (jwt) => {
    setError(null)
    const payload = decodeJwt(jwt)
    if (!payload) {
      setError('Invalid token received from server.')
      return
    }

    pendingPreAuthRef.current = jwt
    setAuthPhase('discovering')

    let userProfile
    try {
      userProfile = await fetchProfile(payload.sub, jwt)
      if (!userProfile) throw new Error('Profile fetch failed')
    } catch (err) {
      setError(err.message)
      setAuthPhase('unauthenticated')
      pendingPreAuthRef.current = null
      return
    }

    const projects = userProfile.projects ?? []
    if (projects.length === 0) {
```

Change to:

```javascript
  const completeOAuth = useCallback(async (jwt) => {
    setError(null)
    const payload = decodeJwt(jwt)
    if (!payload) {
      setError('Invalid token received from server.')
      return
    }

    pendingPreAuthRef.current = jwt
    setAuthPhase('discovering')

    let userProfile
    let publicProjects
    try {
      ;[userProfile, publicProjects] = await Promise.all([
        fetchProfile(payload.sub, jwt),
        fetchPublicProjects(jwt),
      ])
      if (!userProfile) throw new Error('Profile fetch failed')
    } catch (err) {
      setError(err.message)
      setAuthPhase('unauthenticated')
      pendingPreAuthRef.current = null
      return
    }

    const memberProjects = userProfile.projects ?? []
    const memberGroupIds = new Set(memberProjects.map((p) => p.group_id))
    const publicOnly = (publicProjects ?? [])
      .filter((p) => !memberGroupIds.has(p.group_id))
      .map((p) => ({
        group_id:        p.group_id,
        role:            null,
        base_confidence: 0.5,
        is_owner:        false,
        team:            null,
        is_public:       true,
        is_guest:        true,
        name:            p.display_name ?? p.group_id,
      }))
    const projects = [...memberProjects, ...publicOnly]
    if (projects.length === 0) {
```

This is the only change in `completeOAuth()` — the zero/one/many branching below it (lines that reference `projects`) is unchanged, since `projects` is still the same shape it was before (an array of project-membership-like objects), just now potentially containing guest entries too.

- [ ] **Step 3: Manually verify via the dev server**

```bash
npm run dev   # from quorum-dash/, gateway must be running at :3001 with Task 5 deployed
```

In the gateway's dev Postgres, mark a project `is_public: true` (e.g. via `UPDATE q_projects SET is_public = true WHERE group_id = '<some-project>'`), then log in as a GitHub user with zero memberships and confirm the public project now appears in the project selector (or auto-selects, if it's the only one), and that `isGuest` becomes `true` once selected (visible via the dormant `GuestBadge` in `ProjectSelector.jsx` if there's more than one project, or by checking that mutating UI controls are hidden after Task 9/10).

- [ ] **Step 4: Commit**

```bash
git add src/context/AuthContext.jsx
git commit -m "feat(auth): merge is_public projects into completeOAuth project list"
```

---

### Task 9: `Knowledge.jsx` — gate the create-entry button on `isGuest`

**Files:**
- Modify: `src/pages/Knowledge.jsx:39-40` (destructure `isGuest`), `src/pages/Knowledge.jsx:123-128` (wrap the button)

- [ ] **Step 1: Add `isGuest` to the `useAuth()` destructure**

In `src/pages/Knowledge.jsx:39`, change:

```javascript
  const { currentProjectData } = useAuth();
```

to:

```javascript
  const { currentProjectData, isGuest } = useAuth();
```

- [ ] **Step 2: Wrap the "+ Add entry" button**

In `src/pages/Knowledge.jsx:123-128`, change:

```javascript
        <button
          onClick={() => setShowCreateForm(true)}
          className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
        >
          + Add entry
        </button>
```

to:

```javascript
        {!isGuest && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
          >
            + Add entry
          </button>
        )}
```

- [ ] **Step 3: Manually verify**

With the dev server running and a guest session active (per Task 8 Step 3), navigate to `/knowledge` and confirm the "+ Add entry" button is absent. Confirm it still renders normally for a regular member session.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Knowledge.jsx
git commit -m "fix(knowledge): hide create-entry button for guest sessions"
```

---

### Task 10: `DecayingKnowledge.jsx` — gate `BumpButton` on `isGuest`

**Files:**
- Modify: `src/components/stats/DecayingKnowledge.jsx:1-21` (imports + destructure), `src/components/stats/DecayingKnowledge.jsx:94-96` (wrap `BumpButton`)

- [ ] **Step 1: Add the `useAuth` import and `isGuest` destructure**

In `src/components/stats/DecayingKnowledge.jsx:1-21`, change:

```javascript
import { useState } from 'react'
import { useKnowledge } from '../../api/knowledge.js'
import ConfidenceBar from './ConfidenceBar.jsx'
import BumpButton from './BumpButton.jsx'
import { fmtDate } from '../../lib/utils.js'

const FILTERS = [
  { label: 'All',       domain: undefined, maxConf: 1.0  },
  { label: 'Decaying',  domain: undefined, maxConf: 0.5  },
  { label: 'At Risk',   domain: undefined, maxConf: 0.3  },
]

/**
 * Sub-view of the Stats page. Shows knowledge sorted by confidence ascending
 * so engineers can see what's at risk of decaying below the useful floor.
 */
export default function DecayingKnowledge() {
  const [filterIdx, setFilterIdx] = useState(0)
  const [domain,    setDomain]    = useState('')

  const { data, isLoading } = useKnowledge({ domain: domain || undefined, limit: 50 })
```

to:

```javascript
import { useState } from 'react'
import { useKnowledge } from '../../api/knowledge.js'
import { useAuth } from '../../context/AuthContext.jsx'
import ConfidenceBar from './ConfidenceBar.jsx'
import BumpButton from './BumpButton.jsx'
import { fmtDate } from '../../lib/utils.js'

const FILTERS = [
  { label: 'All',       domain: undefined, maxConf: 1.0  },
  { label: 'Decaying',  domain: undefined, maxConf: 0.5  },
  { label: 'At Risk',   domain: undefined, maxConf: 0.3  },
]

/**
 * Sub-view of the Stats page. Shows knowledge sorted by confidence ascending
 * so engineers can see what's at risk of decaying below the useful floor.
 */
export default function DecayingKnowledge() {
  const [filterIdx, setFilterIdx] = useState(0)
  const [domain,    setDomain]    = useState('')

  const { isGuest } = useAuth()
  const { data, isLoading } = useKnowledge({ domain: domain || undefined, limit: 50 })
```

- [ ] **Step 2: Wrap the `BumpButton`**

In `src/components/stats/DecayingKnowledge.jsx:94-96`, change:

```javascript
                  <td className="px-3 py-2 text-right">
                    <BumpButton topic={row.topic} key_={row.key} />
                  </td>
```

to:

```javascript
                  <td className="px-3 py-2 text-right">
                    {!isGuest && <BumpButton topic={row.topic} key_={row.key} />}
                  </td>
```

- [ ] **Step 3: Manually verify**

With a guest session active, navigate to Stats → Decaying Knowledge and confirm no bump button renders in the last column for any row. Confirm it still renders for a regular member session.

- [ ] **Step 4: Commit**

```bash
git add src/components/stats/DecayingKnowledge.jsx
git commit -m "fix(stats): hide bump button for guest sessions"
```

---

### Task 11: E2E browser sub-scenario `S-23.4`

**Files:**
- Create: `tests/e2e/scenarios/23-self-serve-onboarding.spec.js` (new file in quorum-dash — same `S-XX.Y` ID as the API half in `quorum`, per the existing convention of keeping browser halves in a same-numbered file in this repo)

This scenario seeds its own fresh `is_public: true` project directly via API calls (no existing seed helper does this dynamically — `tests/e2e/helpers/seed.js`'s helpers default to the static fixture project), then drives the dashboard as a guest and asserts no write affordance is reachable.

- [ ] **Step 1: Write the new spec file**

Create `tests/e2e/scenarios/23-self-serve-onboarding.spec.js`:

```javascript
import { test, expect } from '@playwright/test'
import axios from 'axios'
import { token } from '../helpers/jwt.js'
import { uid } from '../helpers/seed.js'
import { injectSession } from '../helpers/browser.js'

const { describe } = test

const GATEWAY_URL = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
const PROJECT     = uid('s23-ui-public')
const OWNER       = 'e2e-ui-owner'

/**
 * Seed a fresh is_public: true project directly against the gateway, bypassing
 * the dashboard UI — this scenario only needs the project to already exist so
 * a guest browser session can discover it.
 */
async function seedPublicProject() {
  const ownerJwt = token(OWNER)
  const res = await axios.post(
    `${GATEWAY_URL}/config/upload`,
    {
      group_id:  PROJECT,
      project:   'S-23.4 UI Public Project',
      owner:     OWNER,
      is_public: true,
      members: [{ name: 'E2E UI Owner', github_username: OWNER, role: 'principal_architect', team: 'platform' }],
    },
    {
      headers: { Authorization: `Bearer ${ownerJwt}` },
      validateStatus: () => true,
    },
  )
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`seedPublicProject failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
}

test.describe.configure({ mode: 'serial' })

describe('S-23.4 — Guest browser session for a public project', () => {
  test.beforeAll(async () => {
    await seedPublicProject()
  })

  test('a guest session never renders the create-entry or bump buttons', async ({ page }) => {
    // injectSession mints its own JWT from `sub` — pass role: null and a
    // projects list containing only this one project (with role: null) so
    // AuthContext resolves currentProjectData.role === null, i.e. isGuest.
    await injectSession(page, {
      sub:     's23-ui-discoverer',
      project: PROJECT,
      role:    null,
      projects: [{ group_id: PROJECT, role: null, base_confidence: 0.5, is_owner: false }],
    })

    await page.goto('/knowledge')
    await expect(page.getByRole('button', { name: '+ Add entry' })).toHaveCount(0)

    await page.goto('/stats')
    await expect(page.getByRole('button', { name: /bump/i })).toHaveCount(0)
  })

  test('direct navigation to /config redirects a guest away (MemberRoute regression check)', async ({ page }) => {
    await injectSession(page, {
      sub:     's23-ui-discoverer',
      project: PROJECT,
      role:    null,
      projects: [{ group_id: PROJECT, role: null, base_confidence: 0.5, is_owner: false }],
    })

    await page.goto('/config')
    await expect(page).not.toHaveURL(/\/config$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Requires a running test gateway (per `quorum-dash/CLAUDE.md`) with Task 5's route deployed:

```bash
cd ../quorum && npm run test:e2e:env:setup
cd ../quorum-dash && npx playwright test tests/e2e/scenarios/23-self-serve-onboarding.spec.js
```

Expected: both tests PASS. The second test should already pass today via the pre-existing `MemberRoute` guard (per the design spec's "regression protection" note) — if it fails, that is a pre-existing bug outside this plan's scope; investigate separately rather than altering `MemberRoute`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/scenarios/23-self-serve-onboarding.spec.js
git commit -m "test(e2e): add S-23.4 guest browser session scenario"
```

---

## Self-Review (completed during plan authoring)

**1. Spec coverage** — every numbered item in the design spec's "Backend Changes" (1-4) and "Frontend Changes" (1-3; item 4 folded into Tasks 9-10's button audit, item 5 intentionally skipped as "Optionally" and not required) maps to a task above. "Testing" section's four bullets map to Tasks 2-5 (gateway unit tests), Task 7 (E2E API), Task 11 (E2E browser). "Out of Scope" items are explicitly respected: Task 5's route has no hierarchy filtering, no search UI is built, no backfill script is added (self-heals via Tasks 3-4).

**2. Placeholder scan** — no "TBD"/"similar to Task N"/unfilled error-handling exists in any step; every code block is complete and copy-pasteable.

**3. Type/signature consistency** — `createProject(pg, groupId, owner, members, governance, opts)` signature and `opts.isPublic` field name are identical across Task 2 (implementation), Task 3 (call sites), and their respective test assertions. `fetchPublicProjects(jwt)` return shape (`{ q_project_id, group_id, display_name, owner }`) is identical between Task 5's route, Task 5's test, and Task 8's consumption in `completeOAuth()`. `isGuest` is read via `useAuth()` consistently in Tasks 9 and 10, matching its existing definition at `AuthContext.jsx:505`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-public-project-discovery.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
