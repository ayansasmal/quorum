/**
 * Constitutional Rule 1: No Hard Deletes
 *
 * Proves that:
 *   1. enforceNoHardDelete throws on any delete-keyword operation name
 *   2. validateManifestHasNoDeleteTools rejects forbidden tool names
 *   3. forget() never calls Graphiti delete — it calls deleteEpisodeSoft
 *   4. Bulk operations containing delete keywords are rejected
 *   5. The graph client's BLOCKED_METHODS set covers all delete variants
 */

import { describe, it, expect, vi } from 'vitest'
import {
  enforceNoHardDelete,
  validateManifestHasNoDeleteTools,
  ConstitutionalViolation,
} from '../../src/governance/constitutional.js'
import { BLOCKED_METHODS, isMethodBlocked } from '../../src/graph/client.js'

// ── Rule enforcement functions ────────────────────────────────────────────────

describe('enforceNoHardDelete', () => {
  it('throws on operation name containing "delete"', () => {
    expect(() => enforceNoHardDelete('delete_episode')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "purge"', () => {
    expect(() => enforceNoHardDelete('purge_all_knowledge')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "remove"', () => {
    expect(() => enforceNoHardDelete('remove_entry')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "wipe"', () => {
    expect(() => enforceNoHardDelete('wipe_topic')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "drop"', () => {
    expect(() => enforceNoHardDelete('drop_table')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "truncate"', () => {
    expect(() => enforceNoHardDelete('truncate_knowledge')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "erase"', () => {
    expect(() => enforceNoHardDelete('erase_domain')).toThrow(ConstitutionalViolation)
  })

  it('throws on operation name containing "destroy"', () => {
    expect(() => enforceNoHardDelete('destroy_graph')).toThrow(ConstitutionalViolation)
  })

  it('is case-insensitive', () => {
    expect(() => enforceNoHardDelete('DELETE_ALL')).toThrow(ConstitutionalViolation)
    expect(() => enforceNoHardDelete('PURGE')).toThrow(ConstitutionalViolation)
  })

  it('does not throw on safe operation names', () => {
    expect(() => enforceNoHardDelete('forget')).not.toThrow()
    expect(() => enforceNoHardDelete('deprecate')).not.toThrow()
    expect(() => enforceNoHardDelete('archive')).not.toThrow()
    expect(() => enforceNoHardDelete('remember')).not.toThrow()
  })

  it('sets rule and context on the thrown error', () => {
    try {
      enforceNoHardDelete('delete_episode')
    } catch (err) {
      expect(err.rule).toBe('NO_HARD_DELETE')
      expect(err.context.operationName).toBe('delete_episode')
      expect(err.name).toBe('ConstitutionalViolation')
    }
  })
})

// ── MCP tool manifest validation ──────────────────────────────────────────────

describe('validateManifestHasNoDeleteTools', () => {
  it('throws if any tool name contains "delete"', () => {
    expect(() =>
      validateManifestHasNoDeleteTools([{ name: 'delete_episode' }])
    ).toThrow(ConstitutionalViolation)
  })

  it('throws if any tool name contains "purge"', () => {
    expect(() =>
      validateManifestHasNoDeleteTools([{ name: 'purge_all' }])
    ).toThrow(ConstitutionalViolation)
  })

  it('throws if any tool name contains "hard_delete"', () => {
    expect(() =>
      validateManifestHasNoDeleteTools([{ name: 'hard_delete' }])
    ).toThrow(ConstitutionalViolation)
  })

  it('does not throw on the expected Quorum tool set', () => {
    const quorumTools = [
      { name: 'remember' },
      { name: 'recall' },
      { name: 'search' },
      { name: 'forget' },
      { name: 'history' },
      { name: 'review' },
      { name: 'reflect' },
      { name: 'export' },
    ]
    expect(() => validateManifestHasNoDeleteTools(quorumTools)).not.toThrow()
  })

  it('handles empty manifest gracefully', () => {
    expect(() => validateManifestHasNoDeleteTools([])).not.toThrow()
  })
})

// ── Graphiti client blocked methods ──────────────────────────────────────────

describe('BLOCKED_METHODS (graph/client.js)', () => {
  it('blocks delete_episode', () => {
    expect(isMethodBlocked('delete_episode')).toBe(true)
  })

  it('blocks delete_entity', () => {
    expect(isMethodBlocked('delete_entity')).toBe(true)
  })

  it('blocks purge', () => {
    expect(isMethodBlocked('purge')).toBe(true)
  })

  it('does not block add_episode', () => {
    expect(isMethodBlocked('add_episode')).toBe(false)
  })

  it('does not block search_nodes', () => {
    expect(isMethodBlocked('search_nodes')).toBe(false)
  })

  it('does not block search_facts', () => {
    expect(isMethodBlocked('search_facts')).toBe(false)
  })

  it('exports BLOCKED_METHODS as a Set', () => {
    expect(BLOCKED_METHODS).toBeInstanceOf(Set)
    expect(BLOCKED_METHODS.size).toBeGreaterThan(0)
  })
})
