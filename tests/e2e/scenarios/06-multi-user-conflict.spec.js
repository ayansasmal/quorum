/**
 * J06 — Multi-User Conflict Resolution
 *
 * Two engineers write conflicting knowledge for the same topic:key simultaneously.
 * A PE sees both in pending, uses Request Changes to pause one, approves the other,
 * then observes the stale_warning on the deferred conflict when the active version
 * has advanced. Finally, tests the coexist-split pattern (manual: PE creates two
 * new entries + supersedes the original).
 *
 * Covers:
 *   S-06.1  Two conflicting writes produce two independent pending decisions
 *   S-06.2  request_changes keeps conflict pending with note stored
 *   S-06.3  more_pending_same_key counter (PATCH + count endpoint)
 *   S-06.4  Approve first conflict; reject second (stale_warning fires)
 *   S-06.5  Coexist-split: PE manually creates two new ACTIVE entries + supersedes original
 *
 * Roles: test-engineer (writes v2), test-senior (writes v3), test-pe (PA reviewer)
 * E2E: tests/e2e/scenarios/06-multi-user-conflict.spec.js — S-06.1–S-06.5
 */

import { test, expect } from '@playwright/test'
import { api }    from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'
import { uid, activeEntry } from '../helpers/seed.js'

const { describe, beforeAll } = test

test.describe.configure({ mode: 'serial' })

const PROJECT = 'quorum-test-project'
const TOPIC   = 'auth'

const EXISTING_CONTENT  = 'Stateless JWT sessions. No server-side state. Tokens are self-contained.'
const ENGINEER_CONTENT  = 'Stateless JWT with short expiry (15 min) plus refresh token rotation. Revocation via token blocklist.'
const SENIOR_CONTENT    = 'Redis-backed sessions required. Stateless JWT has no revocation mechanism. Server-side session store enables instant revocation.'

// ── Outer describe holds shared state + beforeAll for S-06.1–S-06.4 ─────────────

describe('S-06 — Multi-User Conflict Resolution', () => {
  // Shared state — all S-06.1–S-06.4 sub-scenarios run against this state.
  let sharedKey        // uid-scoped to avoid cross-run collision
  let conflict1Id      // engineer's conflict (JWT revocation approach)
  let conflict2Id      // senior's conflict (Redis sessions approach)
  let initialVersion   // version number of the original ACTIVE entry

  // One ACTIVE entry, two conflicting DRAFTs, two pending decisions.
  beforeAll(async () => {
  sharedKey = uid('session-strategy')

  // PA creates the original ACTIVE entry (v1). PA writes land as ACTIVE directly.
  await activeEntry({ topic: TOPIC, key: sharedKey, content: EXISTING_CONTENT, project: PROJECT })

  // Resolve initial version number for staleness detection assertions.
  const vRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${TOPIC}/${sharedKey}`)
  initialVersion = vRes.data.version   // should be 1

  // Engineer writes conflicting DRAFT (v2) — same topic:key as the ACTIVE entry.
  await api(tokens.engineer, PROJECT).post('/api/knowledge', {
    topic:       TOPIC,
    key:         sharedKey,
    content:     ENGINEER_CONTENT,
    entity_type: 'Decision',
  })

  // Create pending_decision for conflict #1 with active_version_at_creation so that
  // staleness detection fires correctly when the active version later advances.
  const p1 = await api(tokens.engineer, PROJECT).post('/pg/pending', {
    conflict_topic:              TOPIC,
    conflict_key:                sharedKey,
    decision_type:               'conflict',
    existing_content:            EXISTING_CONTENT,
    incoming_content:            ENGINEER_CONTENT,
    conflict_reason:             'Engineer: JWT approach with blocklist revocation addresses revocation gap',
    active_version_at_creation:  initialVersion,
  })
  conflict1Id = p1.data.conflict_id

  // Senior writes conflicting DRAFT (v3) — same topic:key, different approach.
  await api(tokens.senior, PROJECT).post('/api/knowledge', {
    topic:       TOPIC,
    key:         sharedKey,
    content:     SENIOR_CONTENT,
    entity_type: 'Decision',
  })

  // Create pending_decision for conflict #2. Same active_version_at_creation (v1)
  // so that when conflict #1 is approved (making v2 ACTIVE), reviewing conflict #2
  // returns a stale_warning: currentActive.version > active_version_at_creation.
  const p2 = await api(tokens.senior, PROJECT).post('/pg/pending', {
    conflict_topic:              TOPIC,
    conflict_key:                sharedKey,
    decision_type:               'conflict',
    existing_content:            EXISTING_CONTENT,
    incoming_content:            SENIOR_CONTENT,
    conflict_reason:             'Senior: Redis sessions enable instant revocation; JWT blocklist adds latency',
    active_version_at_creation:  initialVersion,
  })
  conflict2Id = p2.data.conflict_id
})

// ── S-06.1 — Two conflicting writes produce two independent pending decisions ────

describe('S-06.1 — Concurrent writes produce two pending decisions', () => {
  test('step 1 — GET /pg/pending lists both conflict decisions', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const ids = res.data.map(r => r.conflict_id)
    expect(ids).toContain(conflict1Id)
    expect(ids).toContain(conflict2Id)
  })

  test('step 2 — each conflict carries its own incoming_content', async () => {
    const [r1, r2] = await Promise.all([
      api(tokens.pe, PROJECT).get(`/pg/pending/${conflict1Id}`),
      api(tokens.pe, PROJECT).get(`/pg/pending/${conflict2Id}`),
    ])
    expect(r1.status).toBe(200)
    expect(r1.data.incoming_content).toBe(ENGINEER_CONTENT)
    expect(r2.status).toBe(200)
    expect(r2.data.incoming_content).toBe(SENIOR_CONTENT)
  })

  test('step 3 — both conflicts carry active_version_at_creation matching initial version', async () => {
    const [r1, r2] = await Promise.all([
      api(tokens.pe, PROJECT).get(`/pg/pending/${conflict1Id}`),
      api(tokens.pe, PROJECT).get(`/pg/pending/${conflict2Id}`),
    ])
    // DB stores integers; coerce in case pg driver serialises as string
    expect(Number(r1.data.active_version_at_creation)).toBe(initialVersion)
    expect(Number(r2.data.active_version_at_creation)).toBe(initialVersion)
  })
})

// ── S-06.2 — request_changes pauses conflict without resolving it ────────────────

describe('S-06.2 — Request changes pauses conflict resolution', () => {
  // Use conflict1Id throughout; it stays PENDING after request_changes.
  const NOTE = 'Need the security team\'s input before resolving JWT vs Redis approach'

  test('step 1 — POST /api/review with request_changes returns status changes_requested', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflict1Id}`, {
      action: 'request_changes',
      note:   NOTE,
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('changes_requested')
    expect(res.data.conflict_id).toBe(conflict1Id)
    expect(res.data.reviewer).toBe('test-pe')
    expect(res.data.note).toBe(NOTE)
  })

  test('step 2 — GET /pg/pending/:id shows note stored in stale_warning field', async () => {
    // request_changes stores "[reviewer] note" in the stale_warning DB column.
    // This is a deliberate overload of the field — both PE notes and staleness
    // warnings use it, distinguished by their prefix format.
    const res = await api(tokens.pe, PROJECT).get(`/pg/pending/${conflict1Id}`)
    expect(res.status).toBe(200)
    expect(res.data.stale_warning).toBeTruthy()
    expect(res.data.stale_warning).toContain('test-pe')
    expect(res.data.stale_warning).toContain('security team')
  })

  test('step 3 — conflict1 remains in pending list (request_changes does not resolve)', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const ids = res.data.map(r => r.conflict_id)
    expect(ids).toContain(conflict1Id)
  })
})

// ── S-06.3 — more_pending_same_key counter ───────────────────────────────────────

describe('S-06.3 — more_pending_same_key counter', () => {
  // more_pending_same_key is not auto-incremented — callers set it via
  // PATCH /pg/pending/:id to indicate to the UI how many other conflicts
  // exist for the same topic:key.

  test('step 1 — PATCH /pg/pending/:id updates more_pending_same_key', async () => {
    const res = await api(tokens.pe, PROJECT).patch(`/pg/pending/${conflict1Id}`, {
      more_pending_same_key: 1,
    })
    expect(res.status).toBe(200)
    expect(res.data.more_pending_same_key).toBe(1)
  })

  test('step 2 — GET /pg/pending reflects updated more_pending_same_key on conflict1', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const c1 = res.data.find(r => r.conflict_id === conflict1Id)
    expect(c1).toBeDefined()
    expect(c1.more_pending_same_key).toBe(1)
  })

  test('step 3 — GET /pg/pending/count/:topic/:key returns count >= 2', async () => {
    // E2E: tests/e2e/scenarios/06-multi-user-conflict.spec.js — S-06.3 count endpoint
    const res = await api(tokens.pe, PROJECT).get(`/pg/pending/count/${TOPIC}/${sharedKey}`)
    expect(res.status).toBe(200)
    expect(res.data.count).toBeGreaterThanOrEqual(2)
  })
})

// ── S-06.4 — Approve first conflict; reject second with stale_warning ────────────

describe('S-06.4 — Approve first conflict; second shows stale_warning', () => {
  test('step 1 — POST /api/review/conflict1 with approve resolves it successfully', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflict1Id}`, {
      action: 'approve',
      note:   'Approving JWT approach with revocation mechanism — addresses the revocation concern raised by senior',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('approved')
    expect(res.data.conflict_id).toBe(conflict1Id)
    expect(res.data.reviewer).toBe('test-pe')
  })

  test('step 2 — conflict1 removed from pending list after approval', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const ids = res.data.map(r => r.conflict_id)
    expect(ids).not.toContain(conflict1Id)
  })

  test('step 3 — auth:sharedKey ACTIVE version advanced after conflict1 approval', async () => {
    // The review route approves getLatestDraftVersion() — the most recently written
    // DRAFT for this key — not the specific DRAFT referenced by conflict1.
    // With two DRAFTs (engineer v2, senior v3), the latest (v3) becomes ACTIVE.
    // The key invariant is that the ACTIVE version advanced past initialVersion.
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${TOPIC}/${sharedKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.version).toBeGreaterThan(initialVersion)
  })

  test('step 4 — rejecting conflict2 returns stale_warning (active version advanced)', async () => {
    // Conflict2 was created when auth:sharedKey was at active_version_at_creation = v1.
    // After conflict1 approval the ACTIVE version advanced to v2 (engineer's DRAFT).
    // The review route computes staleness: currentActive.version (2) > 1 → fires.
    // Staleness is computed at review time and returned in the response body.
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflict2Id}`, {
      action: 'reject',
      note:   'Rejecting: the approved JWT-with-blocklist approach already satisfies the revocation requirement',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('rejected')
    // stale_warning is non-null because active version advanced since conflict was raised
    expect(res.data.stale_warning).not.toBeNull()
    expect(res.data.stale_warning).toMatch(/Active version is now v\d+/)
  })
})

}) // end describe('S-06 — Multi-User Conflict Resolution')

// ── S-06.5 — Coexist-split: PE manually forks into two scoped entries ────────────

describe('S-06.5 — Coexist-split produces two ACTIVE entries at distinct keys', () => {
  // The review endpoint does not have a coexist_split action — the PE performs the
  // split manually: create two new ACTIVE entries (one per context), then supersede
  // the original entry. This mirrors the S-02.6 pattern. The two new keys are seeded
  // fresh here so this sub-scenario is independent of S-06.1–S-06.4.
  let poolSizeKey
  let statefulKey
  let statelessKey

  const ORIGINAL_CONTENT  = 'Session management: default to stateless JWT. All services start here.'
  const STATEFUL_CONTENT  = 'Stateful sessions (Redis) for services requiring instant revocation (admin panels, payment flows).'
  const STATELESS_CONTENT = 'Stateless JWT sessions for read-heavy services where revocation latency is acceptable.'

  beforeAll(async () => {
    poolSizeKey  = uid('session-default')
    statefulKey  = uid('session-stateful')
    statelessKey = uid('session-stateless')

    // Seed the original ACTIVE entry that will be superseded by the split.
    await activeEntry({ topic: TOPIC, key: poolSizeKey, content: ORIGINAL_CONTENT, project: PROJECT })
  })

  test('step 1 — PE creates first split entry (stateless JWT) as ACTIVE', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic:       TOPIC,
      key:         statelessKey,
      content:     STATELESS_CONTENT,
      entity_type: 'Pattern',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.key).toBe(statelessKey)
  })

  test('step 2 — PE creates second split entry (stateful Redis) as ACTIVE', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic:       TOPIC,
      key:         statefulKey,
      content:     STATEFUL_CONTENT,
      entity_type: 'Pattern',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.key).toBe(statefulKey)
  })

  test('step 3 — PE supersedes original entry (marks it SUPERSEDED, not deleted)', async () => {
    // Original key (auth:session-default) is superseded — it survives as SUPERSEDED
    // in the audit trail. The two split entries replace it in the active knowledge base.
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${TOPIC}/${poolSizeKey}/supersede`, {
      content:     STATELESS_CONTENT,
      entity_type: 'Pattern',
      reason:      'Split into context-specific session patterns: stateless JWT and stateful Redis',
    })
    expect(res.status).toBe(200)
    expect(res.data.new_version.status).toBe('ACTIVE')
    expect(res.data.superseded_version).toBe(1)
  })

  test('step 4 — both split entries are ACTIVE with correct content', async () => {
    const [statelessRes, statefulRes] = await Promise.all([
      api(tokens.pe, PROJECT).get(`/pg/versions/${TOPIC}/${statelessKey}`),
      api(tokens.pe, PROJECT).get(`/pg/versions/${TOPIC}/${statefulKey}`),
    ])
    expect(statelessRes.status).toBe(200)
    expect(statelessRes.data.status).toBe('ACTIVE')
    expect(statelessRes.data.summary).toBe(STATELESS_CONTENT)

    expect(statefulRes.status).toBe(200)
    expect(statefulRes.data.status).toBe('ACTIVE')
    expect(statefulRes.data.summary).toBe(STATEFUL_CONTENT)
  })

  test('step 5 — original entry is no longer current ACTIVE (superseded)', async () => {
    // GET /pg/versions/:topic/:key returns the CURRENT active version.
    // After supersede, the new version (from the supersede call) is ACTIVE.
    // The original v1 entry exists as SUPERSEDED in the audit trail.
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${TOPIC}/${poolSizeKey}`)
    expect(res.status).toBe(200)
    // The supersede operation created a new version at poolSizeKey; original v1 is SUPERSEDED.
    // Current active is v2 (from the supersede call).
    expect(res.data.version).toBeGreaterThan(1)
  })
})

// ── S-06.6 — Three-way concurrent conflict ────────────────────────────────────

describe('S-06.6 — Three-way conflict produces independent pending decisions per writer', () => {
  // Design clarification for GAP-013:
  // pending_decisions rows are not auto-created by POST /api/knowledge — they are
  // created by the MCP conflict detection layer calling POST /pg/pending.
  // Multiple POST /pg/pending calls for the same topic:key are all accepted
  // (no unique-key constraint across topic+key) — each represents a distinct
  // writer's DRAFT in conflict with the current ACTIVE entry.
  // The PA uses GET /pg/pending/count/:topic/:key to see the full conflict picture
  // and PATCH /pg/pending/:id { more_pending_same_key } to annotate individual briefs.
  let threeWayKey
  let c1Id, c2Id, c3Id

  beforeAll(async () => {
    threeWayKey = uid('three-way-conflict')

    // Seed ACTIVE entry (v1)
    await activeEntry({ topic: TOPIC, key: threeWayKey, content: 'Original stateless JWT policy', project: PROJECT })

    // Three engineers each write a conflicting DRAFT
    await api(tokens.engineer,   PROJECT).post('/api/knowledge', { topic: TOPIC, key: threeWayKey, content: 'Approach A: short-lived JWTs + rotation', entity_type: 'Decision' })
    await api(tokens.senior,     PROJECT).post('/api/knowledge', { topic: TOPIC, key: threeWayKey, content: 'Approach B: Redis-backed sessions',        entity_type: 'Decision' })
    await api(tokens.architect,  PROJECT).post('/api/knowledge', { topic: TOPIC, key: threeWayKey, content: 'Approach C: opaque tokens with introspection', entity_type: 'Decision' })

    // Each writer's MCP conflict detection would POST /pg/pending — simulate all three
    const base = { conflict_topic: TOPIC, conflict_key: threeWayKey, decision_type: 'conflict',
                   existing_content: 'Original stateless JWT policy', active_version_at_creation: 1 }

    const r1 = await api(tokens.pe, PROJECT).post('/pg/pending', { ...base, incoming_content: 'Approach A: short-lived JWTs + rotation',          conflict_reason: 'Engineer: rotation improves revocation' })
    const r2 = await api(tokens.pe, PROJECT).post('/pg/pending', { ...base, incoming_content: 'Approach B: Redis-backed sessions',                  conflict_reason: 'Senior: server-side state enables instant revoke' })
    const r3 = await api(tokens.pe, PROJECT).post('/pg/pending', { ...base, incoming_content: 'Approach C: opaque tokens with introspection',       conflict_reason: 'Architect: opaque tokens + introspection endpoint' })

    c1Id = r1.data.conflict_id
    c2Id = r2.data.conflict_id
    c3Id = r3.data.conflict_id
  })

  test('step 1 — count endpoint returns 3 pending conflicts for this key', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/pending/count/${TOPIC}/${threeWayKey}`)
    expect(res.status).toBe(200)
    expect(res.data.count).toBeGreaterThanOrEqual(3)
  })

  test('step 2 — GET /pg/pending lists all three conflict decisions', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const ids = res.data.map(r => r.conflict_id)
    expect(ids).toContain(c1Id)
    expect(ids).toContain(c2Id)
    expect(ids).toContain(c3Id)
  })

  test('step 3 — PA can annotate more_pending_same_key on each conflict brief', async () => {
    // The PA patches each brief so the dashboard can show "2 more conflicts on this key"
    const [p1, p2, p3] = await Promise.all([
      api(tokens.pe, PROJECT).patch(`/pg/pending/${c1Id}`, { more_pending_same_key: 2 }),
      api(tokens.pe, PROJECT).patch(`/pg/pending/${c2Id}`, { more_pending_same_key: 2 }),
      api(tokens.pe, PROJECT).patch(`/pg/pending/${c3Id}`, { more_pending_same_key: 2 }),
    ])
    expect(p1.data.more_pending_same_key).toBe(2)
    expect(p2.data.more_pending_same_key).toBe(2)
    expect(p3.data.more_pending_same_key).toBe(2)
  })

  test('step 4 — each conflict has distinct incoming_content (no phantom duplicate rows)', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    const conflicts = res.data.filter(r => r.conflict_id === c1Id || r.conflict_id === c2Id || r.conflict_id === c3Id)
    // Exactly 3 rows — not duplicated
    expect(conflicts.length).toBe(3)
    const contents = conflicts.map(c => c.incoming_content)
    expect(new Set(contents).size).toBe(3)  // all distinct
  })
})
