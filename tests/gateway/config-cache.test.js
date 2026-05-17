/**
 * Tests for gateway/src/config-cache.js
 *
 * The config-cache module has real logic (Redis hot path, S3 cold path, DDB
 * profile resolution) that is always mocked in route tests. This file tests
 * the cache module directly by mocking its three dependencies:
 *   - @aws-sdk/client-s3 (S3 calls)
 *   - ./redis.js          (Redis get/set/del/publish)
 *   - ./ddb.js            (getUserProjects / getUserProjectsStrict)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockSend = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(cmd) { return mockSend(cmd) }
  }
  class GetObjectCommand {
    constructor(i) { this.input = i; this._type = 'get' }
  }
  class HeadObjectCommand {
    constructor(i) { this.input = i; this._type = 'head' }
  }
  class PutObjectCommand {
    constructor(i) { this.input = i; this._type = 'put' }
  }
  return { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand }
})

const mockRedis = {
  get:     vi.fn(),
  set:     vi.fn().mockResolvedValue('OK'),
  del:     vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(0),
}

vi.mock('../../gateway/src/redis.js', () => ({
  getRedis: () => mockRedis,
}))

const mockGetUserProjects       = vi.fn()
const mockGetUserProjectsStrict = vi.fn()

vi.mock('../../gateway/src/ddb.js', () => ({
  getUserProjects:       (...args) => mockGetUserProjects(...args),
  getUserProjectsStrict: (...args) => mockGetUserProjectsStrict(...args),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  loadProjectConfig,
  saveProjectConfig,
  invalidateProject,
  loadUserProfile,
  invalidateProfile,
  loadAdminConfig,
  saveAdminConfig,
  isPlatformAdmin,
  getProjectByTokenHash,
} from '../../gateway/src/config-cache.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  group_id: 'test-project',
  owner:    'alice',
  members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
}

function makeBodyStream(str) {
  return { transformToString: async () => str }
}

// ── loadProjectConfig ─────────────────────────────────────────────────────────

describe('loadProjectConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_CONFIG_PATH
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
    delete process.env.QUORUM_CONFIG_PATH
  })

  it('throws when QUORUM_CONFIG_BUCKET and QUORUM_CONFIG_PATH are not set', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    await expect(loadProjectConfig('test-project')).rejects.toThrow('QUORUM_CONFIG_BUCKET not set')
  })

  it('returns cached config from Redis (hot path)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(VALID_CONFIG))
    const config = await loadProjectConfig('test-project')
    expect(config.group_id).toBe('test-project')
    // S3 should not have been called
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('falls through on bad Redis JSON and fetches from S3', async () => {
    // Return invalid JSON from Redis → fall through to S3
    mockRedis.get.mockResolvedValue('{ bad json }')
    mockSend.mockResolvedValue({ Body: makeBodyStream(JSON.stringify(VALID_CONFIG)) })
    const config = await loadProjectConfig('test-project')
    expect(config.group_id).toBe('test-project')
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('fetches from S3 and caches result (cold path)', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockSend.mockResolvedValue({ Body: makeBodyStream(JSON.stringify(VALID_CONFIG)) })
    const config = await loadProjectConfig('test-project')
    expect(config.group_id).toBe('test-project')
    expect(mockRedis.set).toHaveBeenCalledWith(
      'config:test-project',
      expect.any(String),
      'EX',
      expect.any(Number),
    )
  })
})

// ── saveProjectConfig ─────────────────────────────────────────────────────────

describe('saveProjectConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('throws when QUORUM_CONFIG_BUCKET is not set', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    await expect(saveProjectConfig('proj', VALID_CONFIG)).rejects.toThrow('QUORUM_CONFIG_BUCKET not set')
  })

  it('puts to S3 and invalidates Redis cache', async () => {
    mockSend.mockResolvedValue({})
    await saveProjectConfig('test-project', VALID_CONFIG)
    expect(mockSend).toHaveBeenCalledOnce()
    // invalidateProject calls del + publish
    expect(mockRedis.del).toHaveBeenCalledWith('config:test-project')
    expect(mockRedis.publish).toHaveBeenCalledWith('quorum:invalidate', 'config:test-project')
  })
})

// ── invalidateProject ─────────────────────────────────────────────────────────

describe('invalidateProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the config cache key and publishes invalidation', async () => {
    await invalidateProject('my-project')
    expect(mockRedis.del).toHaveBeenCalledWith('config:my-project')
    expect(mockRedis.publish).toHaveBeenCalledWith('quorum:invalidate', 'config:my-project')
  })
})

// ── loadUserProfile ───────────────────────────────────────────────────────────

describe('loadUserProfile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns profile from DDB and caches it (cold path)', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockGetUserProjects.mockResolvedValue([
      { project_id: 'proj-1', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'platform' },
    ])

    const profile = await loadUserProfile('alice')
    expect(profile.github_username).toBe('alice')
    expect(profile.projects).toHaveLength(1)
    expect(profile.projects[0].group_id).toBe('proj-1')
    expect(mockRedis.set).toHaveBeenCalledWith(
      'profile:alice',
      expect.any(String),
      'EX',
      expect.any(Number),
    )
  })

  it('returns empty projects array when DDB returns empty on cold path', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockGetUserProjects.mockResolvedValue([])
    const profile = await loadUserProfile('nobody')
    expect(profile.github_username).toBe('nobody')
    expect(profile.projects).toEqual([])
  })

  it('serves fresh DDB data over stale Redis cache (stale-while-revalidate)', async () => {
    const stale = JSON.stringify({ github_username: 'alice', projects: [{ group_id: 'old' }] })
    mockRedis.get.mockResolvedValue(stale)
    mockGetUserProjectsStrict.mockResolvedValue([
      { project_id: 'new-proj', role: 'engineer', base_confidence: 0.7, is_owner: false, team: null },
    ])

    const profile = await loadUserProfile('alice')
    expect(profile.projects[0].group_id).toBe('new-proj')
  })

  it('falls back to stale Redis cache when DDB strict fails', async () => {
    const stale = JSON.stringify({ github_username: 'alice', projects: [{ group_id: 'stale-proj' }] })
    mockRedis.get.mockResolvedValue(stale)
    mockGetUserProjectsStrict.mockRejectedValue(new Error('DDB unreachable'))

    const profile = await loadUserProfile('alice')
    expect(profile.projects[0].group_id).toBe('stale-proj')
  })

  it('uses null defaults for optional DDB row fields', async () => {
    mockRedis.get.mockResolvedValue(null)
    // Row with no role, team, etc.
    mockGetUserProjects.mockResolvedValue([{ project_id: 'p1' }])
    const profile = await loadUserProfile('bob')
    expect(profile.projects[0].role).toBeNull()
    expect(profile.projects[0].team).toBeNull()
    expect(profile.projects[0].base_confidence).toBe(0.5)
    expect(profile.projects[0].is_owner).toBe(false)
  })
})

// ── invalidateProfile ─────────────────────────────────────────────────────────

describe('invalidateProfile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the profile cache key and publishes invalidation', async () => {
    await invalidateProfile('alice')
    expect(mockRedis.del).toHaveBeenCalledWith('profile:alice')
    expect(mockRedis.publish).toHaveBeenCalledWith('quorum:invalidate', 'profile:alice')
  })
})

// ── loadAdminConfig ───────────────────────────────────────────────────────────

describe('loadAdminConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('returns null when QUORUM_CONFIG_BUCKET is not set', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    const result = await loadAdminConfig()
    expect(result).toBeNull()
  })

  it('returns admin config from Redis (hot path)', async () => {
    const admin = { admins: [{ github_username: 'alice' }] }
    mockRedis.get.mockResolvedValue(JSON.stringify(admin))
    const result = await loadAdminConfig()
    expect(result.admins[0].github_username).toBe('alice')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('falls through bad Redis JSON and fetches from S3', async () => {
    mockRedis.get.mockResolvedValue('bad json }')
    const admin = { admins: [] }
    mockSend.mockResolvedValue({ Body: makeBodyStream(JSON.stringify(admin)) })
    const result = await loadAdminConfig()
    expect(result.admins).toEqual([])
  })

  it('fetches from S3 and caches the admin config (cold path)', async () => {
    mockRedis.get.mockResolvedValue(null)
    const admin = { admins: [{ github_username: 'bob' }] }
    mockSend.mockResolvedValue({ Body: makeBodyStream(JSON.stringify(admin)) })

    const result = await loadAdminConfig()
    expect(result.admins[0].github_username).toBe('bob')
    expect(mockRedis.set).toHaveBeenCalledWith(
      'admin:platform',
      expect.any(String),
      'EX',
      expect.any(Number),
    )
  })

  it('returns null when S3 key does not exist (NoSuchKey)', async () => {
    mockRedis.get.mockResolvedValue(null)
    const err = new Error('no such key')
    err.name = 'NoSuchKey'
    mockSend.mockRejectedValue(err)

    const result = await loadAdminConfig()
    expect(result).toBeNull()
  })

  it('returns null and logs when S3 throws unexpected error', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockSend.mockRejectedValue(new Error('S3 timeout'))
    const result = await loadAdminConfig()
    expect(result).toBeNull()
  })
})

// ── saveAdminConfig ───────────────────────────────────────────────────────────

describe('saveAdminConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('throws when QUORUM_CONFIG_BUCKET is not set', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    await expect(saveAdminConfig({ admins: [] })).rejects.toThrow('QUORUM_CONFIG_BUCKET not set')
  })

  it('puts to S3 and invalidates admin Redis cache', async () => {
    mockSend.mockResolvedValue({})
    await saveAdminConfig({ admins: [{ github_username: 'alice' }] })
    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockRedis.del).toHaveBeenCalledWith('admin:platform')
    expect(mockRedis.publish).toHaveBeenCalledWith('quorum:invalidate', 'admin:platform')
  })
})

// ── isPlatformAdmin ───────────────────────────────────────────────────────────

describe('isPlatformAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('returns true when username is in admin list', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ admins: [{ github_username: 'alice' }] }),
    )
    const result = await isPlatformAdmin('alice')
    expect(result).toBe(true)
  })

  it('returns false when username is not in admin list', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ admins: [{ github_username: 'alice' }] }),
    )
    const result = await isPlatformAdmin('bob')
    expect(result).toBe(false)
  })

  it('returns false when loadAdminConfig returns null', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    const result = await isPlatformAdmin('anyone')
    expect(result).toBe(false)
  })

  it('returns false when admin config has no admins array', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ something: 'else' }))
    const result = await isPlatformAdmin('alice')
    expect(result).toBe(false)
  })
})

// ── getProjectByTokenHash ─────────────────────────────────────────────────────

describe('getProjectByTokenHash', () => {
  it('returns the matching project row', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'q_p1', slug: 'my-project', name: 'My Project' }],
      }),
    }
    const result = await getProjectByTokenHash('sha256-hash', mockPool)
    expect(result.id).toBe('q_p1')
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('token_hash = $1'),
      ['sha256-hash'],
    )
  })

  it('returns null when no project matches the token hash', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await getProjectByTokenHash('unknown-hash', mockPool)
    expect(result).toBeNull()
  })
})
