/**
 * Tests for the idempotent platform-admin boot seed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** @type {ReturnType<typeof vi.fn>} */
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    /** @param {{ _type: string, input: object }} command */
    send(command) { return mockSend(command) }
  }

  class GetObjectCommand {
    /** @param {object} input */
    constructor(input) { this.input = input; this._type = 'get' }
  }

  class HeadObjectCommand {
    /** @param {object} input */
    constructor(input) { this.input = input; this._type = 'head' }
  }

  class PutObjectCommand {
    /** @param {object} input */
    constructor(input) { this.input = input; this._type = 'put' }
  }

  return { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand }
})

/** @type {{ get: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>, del: ReturnType<typeof vi.fn>, publish: ReturnType<typeof vi.fn> }} */
const mockRedis = {
  get:     vi.fn(),
  set:     vi.fn().mockResolvedValue('OK'),
  del:     vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(0),
}

vi.mock('../../gateway/src/redis.js', () => ({
  getRedis: () => mockRedis,
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  getUserProjects:       vi.fn(),
  getUserProjectsStrict: vi.fn(),
}))

import { ensureAdminConfig } from '../../gateway/src/config-cache.js'

describe('ensureAdminConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
    delete process.env.QUORUM_FIRST_ADMIN
    mockRedis.get.mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.QUORUM_CONFIG_BUCKET
    delete process.env.QUORUM_FIRST_ADMIN
  })

  it('does not access S3 when QUORUM_FIRST_ADMIN is unset', async () => {
    const result = await ensureAdminConfig()

    expect(result).toEqual({ seeded: false, reason: 'not_configured' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('seeds one admin with an atomic conditional write when config is absent', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    mockSend.mockImplementation((command) => {
      if (command._type === 'get') {
        return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      }
      return Promise.resolve({})
    })

    const result = await ensureAdminConfig()
    const put = mockSend.mock.calls.map(([command]) => command).find((command) => command._type === 'put')
    const body = JSON.parse(put.input.Body)

    expect(result).toEqual({ seeded: true, count: 1 })
    expect(put.input).toMatchObject({
      Bucket:      'quorum-configs',
      Key:         'configs/.quorum',
      ContentType: 'application/json',
      IfNoneMatch: '*',
    })
    expect(body.admins).toEqual([
      expect.objectContaining({ github_username: 'alice', added_by: 'boot-seed' }),
    ])
    expect(mockRedis.del).toHaveBeenCalledWith('admin:platform')
  })

  it('trims, filters, and deduplicates comma-separated admins', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice, bob, alice, ,carol'
    mockSend.mockImplementation((command) => {
      if (command._type === 'get') {
        return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      }
      return Promise.resolve({})
    })

    const result = await ensureAdminConfig()
    const put = mockSend.mock.calls.map(([command]) => command).find((command) => command._type === 'put')
    const body = JSON.parse(put.input.Body)

    expect(result).toEqual({ seeded: true, count: 3 })
    expect(body.admins.map((admin) => admin.github_username)).toEqual(['alice', 'bob', 'carol'])
  })

  it('skips the write when an admin config already exists', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    mockRedis.get.mockResolvedValue(JSON.stringify({
      admins: [{ github_username: 'existing' }],
    }))

    const result = await ensureAdminConfig()

    expect(result).toEqual({ seeded: false, reason: 'already_exists' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('treats a conditional-write race as already seeded', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    mockSend.mockImplementation((command) => {
      if (command._type === 'get') {
        return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      }
      return Promise.reject(Object.assign(new Error('precondition failed'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      }))
    })

    await expect(ensureAdminConfig()).resolves.toEqual({
      seeded: false,
      reason: 'already_exists',
    })
  })

  it('retries once when S3 reports a conditional request conflict', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    let putAttempts = 0
    mockSend.mockImplementation((command) => {
      if (command._type === 'get') {
        return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      }
      putAttempts += 1
      if (putAttempts === 1) {
        return Promise.reject(Object.assign(new Error('conditional conflict'), {
          name: 'ConditionalRequestConflict',
          $metadata: { httpStatusCode: 409 },
        }))
      }
      return Promise.reject(Object.assign(new Error('precondition failed'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      }))
    })

    await expect(ensureAdminConfig()).resolves.toEqual({
      seeded: false,
      reason: 'already_exists',
    })
    expect(putAttempts).toBe(2)
  })
})
