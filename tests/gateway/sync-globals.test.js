/**
 * Wave B: globals validation in syncOneProject and syncAllConfigs.
 *
 * Tests:
 *  - syncOneProject rejects a config whose globals array includes its own group_id
 *  - syncAllConfigs reports globals_warnings for entries that point to non-global catalogs
 *  - syncAllConfigs emits no warnings when all globals entries have is_global: true
 *  - syncAllConfigs skips validation for catalog IDs not present in the current sync batch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Controllable S3Client mock ────────────────────────────────────────────────
//
// `sendImpl` is replaced per-test to return any S3 response shape needed.
// Default: list returns one key 'payments-service'; GET returns a minimal config.

let sendImpl = async (cmd) => {
  const name = cmd.constructor.name
  if (name === 'ListObjectsV2Command') {
    return { Contents: [{ Key: 'payments-service.quorum.json' }], IsTruncated: false }
  }
  if (name === 'GetObjectCommand') {
    return {
      Body: {
        transformToString: async () => JSON.stringify({
          group_id: 'payments-service',
          owner: 'alice',
        }),
      },
    }
  }
  return {}
}

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(cmd) { return sendImpl(cmd) }
  }
  class ListObjectsV2Command {
    constructor(input) { this.input = input; Object.defineProperty(this, 'constructor', { value: { name: 'ListObjectsV2Command' }, enumerable: false }) }
  }
  class GetObjectCommand {
    constructor(input) { this.input = input; Object.defineProperty(this, 'constructor', { value: { name: 'GetObjectCommand' }, enumerable: false }) }
  }
  return { S3Client, ListObjectsV2Command, GetObjectCommand }
})

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:   vi.fn().mockResolvedValue(null),
  invalidateProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  syncProjectMembers: vi.fn().mockResolvedValue(undefined),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal S3 body response for a given config object.
 * @param {object} config
 */
function s3Body(config) {
  return {
    Body: {
      transformToString: async () => JSON.stringify(config),
    },
  }
}

/**
 * Build a List response for the given projectIds.
 * @param {string[]} projectIds
 */
function s3List(projectIds) {
  return {
    Contents:     projectIds.map((id) => ({ Key: `${id}.quorum.json` })),
    IsTruncated:  false,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncOneProject — self-reference check', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns ok: false when globals includes the project own group_id', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') return s3List(['payments-service'])
      return s3Body({
        group_id: 'payments-service',
        owner:    'alice',
        globals:  ['security-standards', 'payments-service'],  // self-reference
      })
    }

    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    const result = await syncOneProject('quorum-configs', 'payments-service')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/self-reference/)
    expect(result.error).toContain('payments-service')
  })

  it('returns ok: true when globals does not include the project own group_id', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') return s3List(['payments-service'])
      return s3Body({
        group_id: 'payments-service',
        owner:    'alice',
        globals:  ['security-standards'],
      })
    }

    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    const result = await syncOneProject('quorum-configs', 'payments-service')

    expect(result.ok).toBe(true)
  })

  it('returns the parsed config on success for use in cross-catalog validation', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') return s3List(['payments-service'])
      return s3Body({ group_id: 'payments-service', owner: 'alice', globals: ['security-standards'] })
    }

    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    const result = await syncOneProject('quorum-configs', 'payments-service')

    expect(result.ok).toBe(true)
    expect(result.config?.group_id).toBe('payments-service')
    expect(result.config?.globals).toEqual(['security-standards'])
  })
})

describe('syncAllConfigs — cross-catalog globals_warnings', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('includes globals_warnings in the response when globals points to a non-global catalog', async () => {
    // payments-service links to 'security-standards', but security-standards has is_global: false
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return s3List(['payments-service', 'security-standards'])
      }
      const key = cmd.input?.Key ?? ''
      if (key.includes('payments-service')) {
        return s3Body({ group_id: 'payments-service', owner: 'alice', globals: ['security-standards'] })
      }
      if (key.includes('security-standards')) {
        return s3Body({ group_id: 'security-standards', owner: 'sec-team', is_global: false })
      }
      return s3Body({ group_id: 'unknown', owner: 'alice' })
    }

    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    const { syncAllConfigs } = await import('../../gateway/src/routes/sync.js')
    const result = await syncAllConfigs()
    delete process.env.QUORUM_CONFIG_BUCKET

    expect(Array.isArray(result.globals_warnings)).toBe(true)
    expect(result.globals_warnings).toHaveLength(1)
    expect(result.globals_warnings[0].project_id).toBe('payments-service')
    expect(result.globals_warnings[0].catalog_id).toBe('security-standards')
    expect(result.globals_warnings[0].warning).toMatch(/not a global catalog/)
  })

  it('emits no warnings when all globals entries have is_global: true', async () => {
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return s3List(['payments-service', 'security-standards'])
      }
      const key = cmd.input?.Key ?? ''
      if (key.includes('payments-service')) {
        return s3Body({ group_id: 'payments-service', owner: 'alice', globals: ['security-standards'] })
      }
      if (key.includes('security-standards')) {
        return s3Body({ group_id: 'security-standards', owner: 'sec-team', is_global: true })
      }
      return s3Body({ group_id: 'unknown', owner: 'alice' })
    }

    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    const { syncAllConfigs } = await import('../../gateway/src/routes/sync.js')
    const result = await syncAllConfigs()
    delete process.env.QUORUM_CONFIG_BUCKET

    expect(result.globals_warnings).toEqual([])
  })

  it('skips validation for catalog IDs not in the current sync batch', async () => {
    // payments-service links to 'org-base' which was not listed in S3
    sendImpl = async (cmd) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return s3List(['payments-service'])
      }
      return s3Body({ group_id: 'payments-service', owner: 'alice', globals: ['org-base'] })
    }

    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    const { syncAllConfigs } = await import('../../gateway/src/routes/sync.js')
    const result = await syncAllConfigs()
    delete process.env.QUORUM_CONFIG_BUCKET

    // org-base wasn't synced — unknown, no warning emitted
    expect(result.globals_warnings).toEqual([])
  })
})
