/**
 * QuorumConfigSchema — migrated_to_shared_graph field validation.
 *
 * Covers parsing of the new shared-physical-database flag added alongside the
 * `database` override on the Graphiti write path (routes/graphiti.js).
 */

import { describe, it, expect } from 'vitest'
import { QuorumConfigSchema } from '../../gateway/src/shared/config/schema.js'

/** Minimal valid config satisfying all required fields. */
function baseConfig(overrides = {}) {
  return {
    owner:    'alice',
    group_id: 'global-standards',
    is_global: true,
    ...overrides,
  }
}

describe('QuorumConfigSchema — migrated_to_shared_graph', () => {
  it('parses when migrated_to_shared_graph is true', () => {
    const result = QuorumConfigSchema.parse(baseConfig({ migrated_to_shared_graph: true }))
    expect(result.migrated_to_shared_graph).toBe(true)
  })

  it('parses when migrated_to_shared_graph is false', () => {
    const result = QuorumConfigSchema.parse(baseConfig({ migrated_to_shared_graph: false }))
    expect(result.migrated_to_shared_graph).toBe(false)
  })

  it('parses when migrated_to_shared_graph is omitted', () => {
    const result = QuorumConfigSchema.parse(baseConfig())
    expect(result.migrated_to_shared_graph).toBeUndefined()
  })

  it('rejects a non-boolean migrated_to_shared_graph value', () => {
    expect(() => QuorumConfigSchema.parse(baseConfig({ migrated_to_shared_graph: 'yes' }))).toThrow()
  })
})
