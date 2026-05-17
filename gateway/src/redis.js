/**
 * Quorum Gateway — Redis client singletons.
 *
 * Two separate ioredis connections are required:
 *   - Command client  — all GET/SET/DEL/PUBLISH operations
 *   - Subscriber      — SUBSCRIBE operations (ioredis blocks a connection while subscribed)
 *
 * Both are lazy-initialised on first use. REDIS_URL defaults to redis://localhost:6380
 * for local dev outside Docker (gateway inside Docker uses redis://redis:6379).
 */

import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'

/** @type {Redis | null} */
let commandClient = null

/** @type {Redis | null} */
let subscriberClient = null

/**
 * Lazy Redis command client singleton.
 * @returns {Redis}
 */
export function getRedis() {
  if (!commandClient) {
    commandClient = new Redis(REDIS_URL, {
      lazyConnect:     false,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
    })
    commandClient.on('error', (err) => {
      console.error(`[Redis] command client error: ${err.message}`)
    })
  }
  return commandClient
}

/**
 * Lazy Redis subscriber client singleton.
 * Must be a separate connection — once SUBSCRIBE is called, the connection
 * can only receive messages (no commands).
 * @returns {Redis}
 */
export function getSubscriber() {
  if (!subscriberClient) {
    subscriberClient = new Redis(REDIS_URL, {
      lazyConnect:     false,
      enableOfflineQueue: true,
    })
    subscriberClient.on('error', (err) => {
      console.error(`[Redis] subscriber error: ${err.message}`)
    })
  }
  return subscriberClient
}

/**
 * Subscribe to the quorum:invalidate pub/sub channel.
 * Each gateway instance subscribes so that a write on any instance
 * propagates cache eviction to all others.
 *
 * Callback receives the full Redis key that was invalidated
 * (e.g. "config:platform-team", "profile:ayansasmal").
 *
 * @param {(key: string) => void} onInvalidate
 */
export function startInvalidationSubscriber(onInvalidate) {
  const sub = getSubscriber()
  sub.subscribe('quorum:invalidate', (err) => {
    if (err) console.error(`[Redis] subscribe failed: ${err.message}`)
  })
  sub.on('message', (_channel, key) => {
    // Evict from this instance's local cache. In multi-instance deployments,
    // the write-path redis.del() only runs on the instance that performed the
    // write — peers must DEL their own copy on receipt of the pub/sub message
    // or they will serve stale data until TTL.
    //
    // Must use the command client (getRedis()), not the subscriber: once
    // SUBSCRIBE is issued, the subscriber connection cannot send commands.
    getRedis()
      .del(key)
      .catch((err) => {
        console.warn(`[Redis] failed to evict key on invalidation: ${key} — ${err.message}`)
      })
    onInvalidate(key)
  })
}
