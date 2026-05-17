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
import { searchNodes, searchFacts } from '../../gateway/src/shared/graph/client.js'

/**
 * Stub fetch to satisfy the MCP streamable-http session handshake and capture
 * the arguments forwarded to a Graphiti tool call.
 *
 * The graph client performs two POSTs per top-level call:
 *   1. initialize  — returns Mcp-Session-Id header
 *   2. tools/call  — the actual tool invocation (captured here)
 *
 * @returns {{ getToolArgs: () => object | null }}
 */
function stubGraphitiFetch() {
  let toolArgs = null

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.method === 'tools/call') {
      toolArgs = body.params?.arguments ?? null
    }
    return {
      ok:      true,
      status:  200,
      headers: {
        get: (name) => (name.toLowerCase() === 'mcp-session-id' ? 'test-session' : null),
      },
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id:      body.id,
        result:  { structuredContent: { result: { nodes: [], facts: [] } } },
      }),
    }
  }))

  return { getToolArgs: () => toolArgs }
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
