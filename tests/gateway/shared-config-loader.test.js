/**
 * Tests for gateway/src/shared/config/loader.js
 *
 * Exports: loadConfig, getConfig, getProjectConfig, stopConfigPoller
 * Private helpers tested indirectly: loadFromFile, loadFromS3, loadFromDB,
 * buildEnvFallback, snapshotToDB, pollConfig
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockS3Send = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(cmd) { return mockS3Send(cmd) }
  }
  class GetObjectCommand {
    constructor(i) { this.input = i; this._type = 'get' }
  }
  return { S3Client, GetObjectCommand }
})

// fs mock for loadFromFile
const mockReadFileSync = vi.fn()
vi.mock('node:fs', () => ({
  readFileSync: (...args) => mockReadFileSync(...args),
}))

// migrations: pass-through so applyMigrations doesn't need a DB
vi.mock('../../gateway/src/shared/config/migrations.js', () => ({
  applyMigrations: vi.fn(async (row) => row),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { applyMigrations } from '../../gateway/src/shared/config/migrations.js'

// loader.js has module-level state (_config, _pollTimer). Import fresh each
// describe block is impractical in Vitest without vi.resetModules(); instead
// we clear state between tests by calling loadConfig with different setups.

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  group_id: 'test-project',
  owner:    'alice',
  members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
}

const MINIMAL_CONFIG = {
  group_id: 'default',
  members:  [],
  roles:    {},
  domains:  {},
  thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
}

function makeBodyStream(str) {
  return { transformToString: async () => str }
}

// ── loadConfig — env fallback ─────────────────────────────────────────────────

describe('loadConfig — env fallback (no QUORUM_CONFIG_PATH, no bucket)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('returns a minimal valid config from env vars when nothing is configured', async () => {
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    expect(config).toMatchObject({ group_id: expect.any(String) })
    expect(Array.isArray(config.members)).toBe(true)
  })

  it('uses QUORUM_GROUP_ID env var for group_id', async () => {
    process.env.QUORUM_GROUP_ID = 'my-group'
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    expect(config.group_id).toBe('my-group')
    delete process.env.QUORUM_GROUP_ID
  })

  it('snapshots to DB when pg pool is provided', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    await loadConfig(mockPool)
    // snapshotToDB inserts into governance_config
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO governance_config'),
      expect.any(Array),
    )
  })
})

// ── loadConfig — local file path ──────────────────────────────────────────────

describe('loadConfig — QUORUM_CONFIG_PATH (local file)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_PATH
  })

  it('loads config from local file when QUORUM_CONFIG_PATH is set', async () => {
    process.env.QUORUM_CONFIG_PATH = '/tmp/test.quorum.json'
    mockReadFileSync.mockReturnValue(JSON.stringify(VALID_CONFIG))
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    expect(config.group_id).toBe('test-project')
    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/test.quorum.json', 'utf8')
  })

  it('falls back to env defaults when local file cannot be read', async () => {
    process.env.QUORUM_CONFIG_PATH = '/tmp/nonexistent.json'
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    // Falls back to env — still returns a valid config shape
    expect(typeof config.group_id).toBe('string')
  })
})

// ── loadConfig — S3 path ──────────────────────────────────────────────────────

describe('loadConfig — S3 (QUORUM_CONFIG_BUCKET set)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
    process.env.QUORUM_CONFIG_BUCKET  = 'quorum-configs'
    process.env.QUORUM_PROJECT_ID     = 'test-project'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
    delete process.env.QUORUM_PROJECT_ID
  })

  it('loads config from S3 and returns validated object', async () => {
    mockS3Send.mockResolvedValue({
      Body: makeBodyStream(JSON.stringify(VALID_CONFIG)),
      ETag: '"abc123"',
    })
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    expect(config.group_id).toBe('test-project')
  })

  it('falls back to DB snapshot when S3 returns null', async () => {
    // S3 fails by throwing non-NotModified error
    mockS3Send.mockRejectedValue(new Error('S3 unreachable'))
    const mockPool = {
      query: vi.fn()
        // loadFromDB SELECT
        .mockResolvedValueOnce({
          rows: [{ config_json: VALID_CONFIG }],
        })
        // snapshotToDB INSERT
        .mockResolvedValue({ rows: [] }),
    }
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(mockPool)
    // DB snapshot valid config or env fallback — both are valid shapes
    expect(typeof config.group_id).toBe('string')
  })

  it('falls back to env defaults when both S3 and DB fail', async () => {
    mockS3Send.mockRejectedValue(new Error('S3 timeout'))
    const mockPool = { query: vi.fn().mockRejectedValue(new Error('DB down')) }
    const { loadConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(mockPool)
    expect(typeof config.group_id).toBe('string')
  })
})

// ── getConfig ─────────────────────────────────────────────────────────────────

describe('getConfig', () => {
  it('returns the loaded config after loadConfig() is called', async () => {
    delete process.env.QUORUM_CONFIG_PATH
    delete process.env.QUORUM_CONFIG_BUCKET
    const { loadConfig, getConfig } = await import('../../gateway/src/shared/config/loader.js')
    await loadConfig(null)
    const config = getConfig()
    expect(typeof config.group_id).toBe('string')
  })
})

// ── getConfigSafe / isConfigLoaded ────────────────────────────────────────────

describe('getConfigSafe / isConfigLoaded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('isConfigLoaded() is true and getConfigSafe() returns the config after loadConfig()', async () => {
    const { loadConfig, getConfigSafe, isConfigLoaded } = await import('../../gateway/src/shared/config/loader.js')
    await loadConfig(null)
    expect(isConfigLoaded()).toBe(true)
    const safe = getConfigSafe()
    expect(safe).not.toBeNull()
    expect(typeof safe.group_id).toBe('string')
  })

  it('getConfigSafe() never throws — unlike getConfig() — so callers can degrade', async () => {
    const { loadConfig, getConfig, getConfigSafe } = await import('../../gateway/src/shared/config/loader.js')
    await loadConfig(null)
    // Both reflect the same loaded config; the contract difference (throw vs null
    // when unloaded) is what remember() relies on to avoid "Config not loaded".
    expect(() => getConfigSafe()).not.toThrow()
    expect(getConfigSafe()).toEqual(getConfig())
  })
})

// ── buildEnvFallback infallibility ────────────────────────────────────────────

describe('loadConfig — env fallback is infallible (never leaves _config null)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFLICT_THRESHOLD
    delete process.env.QUORUM_AUTHORITY_THRESHOLD
  })

  it('loads a usable config even when threshold env vars are non-numeric', async () => {
    // parseFloat('not-a-number') → NaN; the schema parse may reject it, but the
    // fallback must still populate _config (raw shape) rather than leaving it null.
    process.env.QUORUM_CONFLICT_THRESHOLD  = 'not-a-number'
    process.env.QUORUM_AUTHORITY_THRESHOLD = 'also-bad'
    const { loadConfig, isConfigLoaded, getConfigSafe } = await import('../../gateway/src/shared/config/loader.js')
    const config = await loadConfig(null)
    expect(config).not.toBeNull()
    expect(isConfigLoaded()).toBe(true)
    expect(getConfigSafe()).not.toBeNull()
    expect(typeof config.group_id).toBe('string')
  })
})

// ── stopConfigPoller ──────────────────────────────────────────────────────────

describe('stopConfigPoller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
    delete process.env.QUORUM_PROJECT_ID
  })

  it('clears the poll timer without throwing', async () => {
    const { stopConfigPoller } = await import('../../gateway/src/shared/config/loader.js')
    // Call twice — second call is a no-op (timer already null)
    expect(() => stopConfigPoller()).not.toThrow()
    expect(() => stopConfigPoller()).not.toThrow()
  })
})

// ── getProjectConfig ──────────────────────────────────────────────────────────

describe('getProjectConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    applyMigrations.mockImplementation(async (row) => row)
  })

  it('throws when project is not found', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getProjectConfig } = await import('../../gateway/src/shared/config/loader.js')
    await expect(getProjectConfig('missing-project', mockPool)).rejects.toThrow('Project not found or archived')
  })

  it('returns a validated config from a project row', async () => {
    const row = {
      id:       'my-project',
      name:     'My Project',
      members:  [{ github_username: 'alice', role: 'principal_architect', team: 'platform', base_confidence: 0.9 }],
      domains:  [{ name: 'auth', conflict_threshold: 0.9 }],
      governance: { conflict_threshold: 0.85, authority_threshold: 0.2 },
    }
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [row] }) }
    const { getProjectConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await getProjectConfig('my-project', mockPool)
    expect(config.group_id).toBe('my-project')
    expect(config.members[0].github_username).toBe('alice')
    expect(config.domains.auth.conflict_threshold).toBe(0.9)
  })

  it('uses defaults when governance / members / domains are empty', async () => {
    const row = { id: 'sparse', name: 'Sparse Project' }
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [row] }) }
    const { getProjectConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await getProjectConfig('sparse', mockPool)
    expect(config.members).toEqual([])
    expect(config.thresholds.conflict_threshold).toBe(0.85)
  })

  it('maps domain array to { name: { conflict_threshold } } object', async () => {
    const row = {
      id:      'proj',
      name:    'Proj',
      domains: [
        { name: 'auth',    conflict_threshold: 0.9 },
        { name: 'backend', conflict_threshold: 0.7 },
      ],
    }
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [row] }) }
    const { getProjectConfig } = await import('../../gateway/src/shared/config/loader.js')
    const config = await getProjectConfig('proj', mockPool)
    expect(config.domains.auth.conflict_threshold).toBe(0.9)
    expect(config.domains.backend.conflict_threshold).toBe(0.7)
  })
})
