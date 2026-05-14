/**
 * Redis cache invalidation pub/sub — multi-instance correctness.
 *
 * Gap 8: The subscriber callback previously only logged invalidation messages
 * without evicting the local cache. In multi-instance deployments, only the
 * writing instance (which calls redis.del() on the write-path) would evict;
 * other instances served stale data until TTL.
 *
 * These tests verify that:
 *   1. The subscriber, on receiving a quorum:invalidate message, calls
 *      del(key) on the command client (NOT the subscriber client, which is
 *      in SUBSCRIBE mode and cannot issue commands).
 *   2. A failing del() does not crash the process and is logged at warn level.
 *   3. getRedis() and getSubscriber() return separate ioredis connections.
 *
 * ioredis is mocked so the tests do not require a live Redis. Each test resets
 * modules so the singleton state in redis.js does not leak across tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Build a fake ioredis instance with the methods we exercise.
 * Each call to the mocked default export returns a fresh fake so the
 * command client and subscriber are independent objects (verifying the
 * "separate connection" invariant).
 *
 * @returns {{ Redis: any, instances: any[] }}
 */
function makeRedisMock() {
  /** @type {any[]} */
  const instances = []

  /** Fake ioredis ctor — returns a unique object per instantiation. */
  function FakeRedis() {
    /** @type {Record<string, Function[]>} */
    const handlers = {}
    const inst = {
      __id:        instances.length,
      del:         vi.fn().mockResolvedValue(1),
      subscribe:   vi.fn((_channel, cb) => { if (cb) cb(null) }),
      publish:     vi.fn().mockResolvedValue(1),
      on:          vi.fn((evt, fn) => {
        ;(handlers[evt] ??= []).push(fn)
        return inst
      }),
      /** Test helper — emit an event as ioredis would. */
      __emit: (evt, ...args) => {
        for (const fn of handlers[evt] ?? []) fn(...args)
      },
    }
    instances.push(inst)
    return inst
  }

  return { Redis: FakeRedis, instances }
}

describe('gateway/redis — invalidation subscriber', () => {
  /** @type {ReturnType<typeof makeRedisMock>} */
  let mock

  beforeEach(async () => {
    vi.resetModules()
    mock = makeRedisMock()
    vi.doMock('ioredis', () => ({ default: mock.Redis }))
  })

  afterEach(() => {
    vi.doUnmock('ioredis')
    vi.restoreAllMocks()
  })

  it('uses a separate connection for subscriber vs command client', async () => {
    const { getRedis, getSubscriber } = await import('../../gateway/src/redis.js')
    const cmd = getRedis()
    const sub = getSubscriber()
    expect(cmd).not.toBe(sub)
    expect(mock.instances.length).toBe(2)
  })

  it('calls del() on the command client when an invalidation message arrives', async () => {
    const { getRedis, getSubscriber, startInvalidationSubscriber } = await import(
      '../../gateway/src/redis.js'
    )

    const cmd = getRedis()
    const sub = getSubscriber()

    startInvalidationSubscriber(() => {})

    // Simulate a pub/sub message arriving on the subscriber connection.
    sub.__emit('message', 'quorum:invalidate', 'config:platform-team')

    // Yield to allow any awaited promise inside the handler to settle.
    await new Promise((r) => setImmediate(r))

    expect(cmd.del).toHaveBeenCalledWith('config:platform-team')
    expect(sub.del).not.toHaveBeenCalled()
  })

  it('catches del() rejection and logs a warning (no unhandled rejection)', async () => {
    const { getRedis, getSubscriber, startInvalidationSubscriber } = await import(
      '../../gateway/src/redis.js'
    )

    const cmd = getRedis()
    const sub = getSubscriber()
    cmd.del.mockRejectedValueOnce(new Error('connection lost'))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let unhandled = null
    const onUnhandled = (err) => { unhandled = err }
    process.on('unhandledRejection', onUnhandled)

    try {
      startInvalidationSubscriber(() => {})
      sub.__emit('message', 'quorum:invalidate', 'profile:ayansasmal')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(cmd.del).toHaveBeenCalledWith('profile:ayansasmal')
      expect(warnSpy).toHaveBeenCalled()
      expect(unhandled).toBeNull()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
