/**
 * Gateway: DDB failure handling (Gap 7)
 *
 * Verifies that `getUserProjects` surfaces DDB failures via console.warn
 * rather than silently returning [], and that `loadUserProfile` serves a
 * stale Redis cache when DDB throws (rather than caching an empty profile
 * which would downgrade every user's role to null during a DDB outage).
 *
 * Mocks:
 *   - @aws-sdk/client-dynamodb → control DynamoDBClient.send()
 *   - ../../gateway/src/redis.js → control Redis get/set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const sendMock = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal()
  class DynamoDBClient {
    send(...args) { return sendMock(...args) }
  }
  return { ...actual, DynamoDBClient }
})

const redisMock = {
  get:     vi.fn(),
  set:     vi.fn().mockResolvedValue('OK'),
  setex:   vi.fn().mockResolvedValue('OK'),
  del:     vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(0),
}

vi.mock('../../gateway/src/redis.js', () => ({
  getRedis: () => redisMock,
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { getUserProjects } from '../../gateway/src/ddb.js'
import { loadUserProfile } from '../../gateway/src/config-cache.js'

// ── Setup ─────────────────────────────────────────────────────────────────────

let warnSpy
let errorSpy

beforeEach(() => {
  sendMock.mockReset()
  redisMock.get.mockReset()
  redisMock.set.mockClear()
  warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getUserProjects() — DDB failure handling', () => {
  it('emits a warn log when DDB throws and returns []', async () => {
    sendMock.mockRejectedValueOnce(new Error('DDB unavailable'))

    const result = await getUserProjects('alice')

    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(message).toMatch(/getUserProjects/i)
    expect(message).toMatch(/alice/)
    expect(message).toMatch(/DDB unavailable/)
  })

  it('returns mapped rows on success without warning', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          github_username: { S: 'alice' },
          project_id:      { S: 'proj-1' },
          role:            { S: 'principal_architect' },
          is_owner:        { BOOL: true },
          base_confidence: { N: '0.9' },
        },
      ],
    })

    const result = await getUserProjects('alice')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      project_id: 'proj-1',
      role:       'principal_architect',
      is_owner:   true,
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('loadUserProfile() — stale-cache preference on DDB failure', () => {
  it('returns the stale cached profile when DDB throws and cache exists', async () => {
    const staleProfile = {
      github_username: 'bob',
      projects: [
        { group_id: 'proj-1', role: 'senior', base_confidence: 0.7, is_owner: false, team: 'core' },
      ],
    }
    redisMock.get.mockResolvedValueOnce(JSON.stringify(staleProfile))
    sendMock.mockRejectedValueOnce(new Error('DDB down'))

    const profile = await loadUserProfile('bob')

    expect(profile).toEqual(staleProfile)
    expect(profile.projects[0].role).toBe('senior')
    expect(warnSpy).toHaveBeenCalled()
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(message).toMatch(/stale cache|loadUserProfile/i)
  })

  it('overwrites cache with fresh DDB result when both cache and DDB succeed', async () => {
    const staleProfile = {
      github_username: 'carol',
      projects: [{ group_id: 'old-proj', role: 'engineer', base_confidence: 0.5, is_owner: false, team: null }],
    }
    redisMock.get.mockResolvedValueOnce(JSON.stringify(staleProfile))
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          github_username: { S: 'carol' },
          project_id:      { S: 'new-proj' },
          role:            { S: 'principal_architect' },
          is_owner:        { BOOL: true },
          base_confidence: { N: '0.9' },
        },
      ],
    })

    const profile = await loadUserProfile('carol')

    expect(profile.projects).toHaveLength(1)
    expect(profile.projects[0].group_id).toBe('new-proj')
    expect(profile.projects[0].role).toBe('principal_architect')

    // Verify fresh result was written back to Redis
    const writes = [...redisMock.set.mock.calls, ...redisMock.setex.mock.calls]
    expect(writes.length).toBeGreaterThan(0)
    const serialized = writes.map((args) => args.find((a) => typeof a === 'string' && a.includes('new-proj')))
    expect(serialized.some(Boolean)).toBe(true)
  })

  it('cold path: no cache + DDB throws → returns empty profile shape', async () => {
    redisMock.get.mockResolvedValueOnce(null)
    sendMock.mockRejectedValueOnce(new Error('DDB cold-path failure'))

    const profile = await loadUserProfile('dave')

    expect(profile).toEqual({ github_username: 'dave', projects: [] })
    // warn from getUserProjects (cold path can't serve stale — empty is the only option)
    expect(warnSpy).toHaveBeenCalled()
  })
})
