/**
 * Graphiti client — group_ids project scoping for searchNodes and searchFacts.
 *
 * Previously, both functions intentionally omitted group_ids because hyphens
 * in project IDs broke FalkorDB/RediSearch. That root cause is now fixed:
 * project IDs are normalised to underscores at both the MCP resolveCtx() and
 * the gateway Graphiti proxy. group_ids may therefore be passed through safely
 * to restore project isolation for semantic search.
 *
 * These tests stub fetch and inspect the payload posted to Graphiti's MCP
 * endpoint to confirm group_ids is forwarded when (and only when) a groupId
 * option is supplied by the caller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchNodes, searchFacts, addEpisode, addSupersedingEpisode } from '../../gateway/src/shared/graph/client.js'

/**
 * Stub fetch for a single, stateless `tools/call` POST and capture the
 * arguments forwarded to a Graphiti tool call.
 *
 * Graphiti's MCP server runs with `stateless_http=True`: every call is one
 * self-contained POST with method="tools/call" — no initialize handshake,
 * no Mcp-Session-Id header.
 *
 * @returns {{ getToolArgs: () => object | null, getAllCalls: () => Array<{ headers: object, body: object }> }}
 */
function stubGraphitiFetch() {
  let toolArgs = null
  const calls = []

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push({ headers: opts.headers ?? {}, body })
    if (body.method === 'tools/call') {
      toolArgs = body.params?.arguments ?? null
    }
    return {
      ok:      true,
      status:  200,
      headers: {
        get: () => null,
      },
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id:      body.id,
        result:  { structuredContent: { result: { nodes: [], facts: [] } } },
      }),
    }
  }))

  return { getToolArgs: () => toolArgs, getAllCalls: () => calls }
}

beforeEach(() => {
  // Ensure the client talks directly to Graphiti (not through the gateway) so
  // no extra Authorization handshake is required for these unit tests.
  delete process.env.QUORUM_GATEWAY_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchNodes — group_ids scoping', () => {
  it('sends group_ids when groupId option is provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('auth patterns', { groupId: 'amethyst_munchkin' })

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
    expect(args.query).toBe('auth patterns')
  })

  it('omits group_ids when no groupId option is given', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('auth patterns', {})

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toBeUndefined()
  })

  it('normalises groupId from groupIds array', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('query', { groupIds: ['amethyst_munchkin'] })

    const args = getToolArgs()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
  })
})

describe('addEpisode — database override', () => {
  it('sends database in the add_memory payload when provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addEpisode('use jwt', { key: 'auth:jwt', source: 'test' }, 'amethyst-munchkin', 'quorum_shared_globals')

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBe('quorum_shared_globals')
    expect(args.group_id).toBe('amethyst_munchkin')
  })

  it('omits database when not provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addEpisode('use jwt', { key: 'auth:jwt', source: 'test' }, 'amethyst-munchkin')

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBeUndefined()
  })
})

describe('addSupersedingEpisode — database override', () => {
  it('sends database in the add_memory payload when provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addSupersedingEpisode(
      'use jwt v2',
      'old-episode-id',
      { key: 'auth:jwt', source: 'test', reason: 'updated' },
      'amethyst-munchkin',
      'quorum_shared_globals',
    )

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBe('quorum_shared_globals')
  })

  it('omits database when not provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addSupersedingEpisode(
      'use jwt v2',
      'old-episode-id',
      { key: 'auth:jwt', source: 'test', reason: 'updated' },
      'amethyst-munchkin',
    )

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBeUndefined()
  })
})

describe('searchFacts — group_ids scoping', () => {
  it('sends group_ids when groupId option is provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('auth patterns', { groupId: 'amethyst_munchkin' })

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
    expect(args.query).toBe('auth patterns')
  })

  it('omits group_ids when no groupId option is given', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('auth patterns', {})

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toBeUndefined()
  })

  it('normalises groupId from groupIds array', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('query', { groupIds: ['amethyst_munchkin'] })

    const args = getToolArgs()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
  })
})

describe('callGraphiti — stateless concurrency', () => {
  // Regression test for quorum/docs/RCA-search-concurrency-session-stall-2026-07-27.md:
  // concurrent calls used to share one cached Mcp-Session-Id with no locking, so one
  // caller could get no response until its own timeout fired. Each call is now a fully
  // independent request — no session to race on.
  it('fires one independent request per concurrent call, none carrying a session header', async () => {
    const { getAllCalls } = stubGraphitiFetch()

    const CONCURRENCY = 5
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        searchNodes(`query-${i}`, { groupId: 'amethyst_munchkin' })),
    )

    const calls = getAllCalls()
    expect(calls).toHaveLength(CONCURRENCY)

    const queries = calls.map((c) => c.body.params?.arguments?.query).sort()
    expect(queries).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => `query-${i}`).sort())

    for (const call of calls) {
      const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase())
      expect(headerNames).not.toContain('mcp-session-id')
    }
  })
})
