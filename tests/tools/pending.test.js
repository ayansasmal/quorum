/**
 * Tool: pending()
 *
 * Tests staleness detection in the pending handler.
 * Verifies:
 *   1. Stale warning is generated when active version has advanced since conflict creation
 *   2. No warning when active version matches version at creation time
 *   3. Empty queue returns a clean summary with zero counts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion:        vi.fn(),
  getPendingDecisions:      vi.fn(),
  getDraftVersions:         vi.fn(),
  markPendingDecisionStale: vi.fn(),
  // Other exports used elsewhere — satisfy the mock module contract
  getVersionHistory:        vi.fn(),
  getVersionAtDate:         vi.fn(),
  getSpecificVersion:       vi.fn(),
  insertVersion:            vi.fn(),
  transitionVersionStatus:  vi.fn(),
  insertVersionAuditLink:   vi.fn(),
  getNextVersionNumber:     vi.fn(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(() => ({ domains: {} })),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  getCurrentVersion,
  getPendingDecisions,
  getDraftVersions,
  markPendingDecisionStale,
} from '../../src/graph/queries.js'

import { handler } from '../../src/tools/pending.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** @type {import('pg').Pool} */
const pg = {}

/** Minimal identity object */
const identity = { name: 'reviewer', role: 'engineer' }

/**
 * Build a pending conflict row as returned by getPendingDecisions().
 * @param {object} [overrides]
 */
function makePendingRow(overrides = {}) {
  return {
    conflict_id:               'conflict_abc',
    conflict_topic:            'auth',
    conflict_key:              'token-strategy',
    active_version_at_creation: 1,
    stale_warning:             null,
    existing_content:          'Use session tokens',
    incoming_content:          'Use JWT',
    conflict_reason:           'Different auth approaches',
    more_pending_same_key:     0,
    enrichment:                null,
    created_at:                new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pending() — staleness detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDraftVersions.mockResolvedValue([])
  })

  it('shows stale warning when active version has advanced since conflict creation', async () => {
    // Conflict was created when v1 was active; v3 is now active
    getPendingDecisions.mockResolvedValue([makePendingRow({ active_version_at_creation: 1 })])
    getCurrentVersion.mockResolvedValue({ version: 3 })
    markPendingDecisionStale.mockResolvedValue(undefined)

    const result = await handler(pg, {}, identity)

    expect(result.conflict_briefs).toHaveLength(1)
    const brief = result.conflict_briefs[0]

    // Stale warning must be present and mention both versions
    expect(brief.stale_warning).toBeTruthy()
    expect(brief.stale_warning).toMatch(/v1/)
    expect(brief.stale_warning).toMatch(/v3/)

    // Current version is reflected in the brief
    expect(brief.current_active_version).toBe(3)
    expect(brief.active_version_at_creation).toBe(1)

    // Side-effect: stale state must be persisted to the DB
    expect(markPendingDecisionStale).toHaveBeenCalledWith(
      pg,
      'conflict_abc',
      expect.stringContaining('v3'),
      3,
    )
  })

  it('shows no stale warning when active version matches version at creation time', async () => {
    // Conflict was created at v3 and v3 is still active — no staleness
    getPendingDecisions.mockResolvedValue([makePendingRow({ active_version_at_creation: 3 })])
    getCurrentVersion.mockResolvedValue({ version: 3 })

    const result = await handler(pg, {}, identity)

    expect(result.conflict_briefs).toHaveLength(1)
    expect(result.conflict_briefs[0].stale_warning).toBeNull()

    // No side-effect: DB should not be updated
    expect(markPendingDecisionStale).not.toHaveBeenCalled()
  })

  it('returns a clean empty response when the queue has no pending decisions', async () => {
    getPendingDecisions.mockResolvedValue([])

    const result = await handler(pg, {}, identity)

    expect(result.conflict_briefs).toHaveLength(0)
    expect(result.draft_reviews).toHaveLength(0)
    expect(result.summary).toMatchObject({
      total_pending: 0,
      conflicts:     0,
      drafts:        0,
    })
  })
})
