/**
 * GET /api/graph — topic-intermediate-node graph structure tests.
 *
 * Verifies the 3-level hierarchy (hub → topic → key) in the unfiltered view
 * and the flat 2-level layout (hub → key) when ?domain= is provided.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockUser = { sub: 'alice', project: 'eng', role: 'principal_architect', is_admin: false, qProjectId: 'q_p1' }

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => { req.user = mockUser; next() },
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn().mockResolvedValue('q_p1'),
}))

// ── App bootstrap ─────────────────────────────────────────────────────────────

let server, baseUrl

const DB_ROWS_MULTI_TOPIC = [
  { version_id: 'v1', topic: 'auth',    key: 'oauth-flow',    version: 1, entity_type: 'Pattern',    confidence: 0.9, author: 'alice', summary: 'OAuth flow', status: 'ACTIVE', supersedes_version: null, tags: ['security'] },
  { version_id: 'v2', topic: 'auth',    key: 'jwt-shape',     version: 1, entity_type: 'Decision',   confidence: 0.8, author: 'alice', summary: 'JWT shape',  status: 'ACTIVE', supersedes_version: null, tags: ['security'] },
  { version_id: 'v3', topic: 'deploy',  key: 'helm-defaults', version: 1, entity_type: 'Runbook',    confidence: 0.7, author: 'bob',   summary: 'Helm',       status: 'ACTIVE', supersedes_version: null, tags: [] },
]

const DB_ROWS_SINGLE_TOPIC = [
  { version_id: 'v1', topic: 'auth', key: 'oauth-flow', version: 1, entity_type: 'Pattern', confidence: 0.9, author: 'alice', summary: 'OAuth flow', status: 'ACTIVE', supersedes_version: null, tags: [] },
  { version_id: 'v2', topic: 'auth', key: 'jwt-shape',  version: 1, entity_type: 'Decision', confidence: 0.8, author: 'alice', summary: 'JWT shape', status: 'ACTIVE', supersedes_version: null, tags: [] },
]

function makeMockPool(rows, groupId = 'eng-team') {
  return {
    query: vi.fn().mockImplementation((sql) => {
      if (/COUNT/.test(sql))       return Promise.resolve({ rows: [{ cnt: rows.length }] })
      if (/q_projects/.test(sql))  return Promise.resolve({ rows: [{ group_id: groupId }] })
      return Promise.resolve({ rows })
    }),
  }
}

beforeAll(async () => {
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = mockUser
    next()
  })
  app.use('/api', dashboardRouter)
  server  = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchGraph(pool, query = '') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = mockUser; req.app.locals.pool = pool; next() })
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  app.use('/api', dashboardRouter)
  const srv = http.createServer(app)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/api/graph${query}`
  const res = await fetch(url)
  const body = await res.json()
  await new Promise((r) => srv.close(r))
  return { status: res.status, body }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/graph — unfiltered (3-level hierarchy)', () => {
  it('hub node label is the canonical group_id from q_projects', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC, 'my-eng-team')
    const { body } = await fetchGraph(pool)
    const hub = body.nodes.find((n) => n.data.node_type === 'hub')
    expect(hub.data.label).toBe('my-eng-team')
    expect(hub.data.group_id).toBe('my-eng-team')
  })

  it('emits topic nodes for each unique topic', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC)
    const { status, body } = await fetchGraph(pool)
    expect(status).toBe(200)
    const topicNodes = body.nodes.filter((n) => n.data.node_type === 'topic')
    const topicLabels = topicNodes.map((n) => n.data.label).sort()
    expect(topicLabels).toEqual(['auth', 'deploy'])
  })

  it('each topic node id is topic:<name>', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC)
    const { body } = await fetchGraph(pool)
    const topicNode = body.nodes.find((n) => n.data.id === 'topic:auth')
    expect(topicNode).toBeDefined()
    expect(topicNode.data.node_type).toBe('topic')
  })

  it('key nodes connect to their topic node, not the hub', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC)
    const { body } = await fetchGraph(pool)
    const keyEdge = body.edges.find((e) => e.data.source === 'auth:oauth-flow:1')
    expect(keyEdge.data.target).toBe('topic:auth')
    expect(keyEdge.data.type).toBe('BELONGS_TO')
  })

  it('topic nodes connect to the hub', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC)
    const { body } = await fetchGraph(pool)
    const topicHubEdge = body.edges.find((e) => e.data.source === 'topic:deploy')
    expect(topicHubEdge.data.target).toMatch(/^project:/)
    expect(topicHubEdge.data.type).toBe('BELONGS_TO')
  })

  it('no key node has a direct BELONGS_TO edge to the hub', async () => {
    const pool = makeMockPool(DB_ROWS_MULTI_TOPIC)
    const { body } = await fetchGraph(pool)
    const hubId   = body.nodes.find((n) => n.data.node_type === 'hub').data.id
    const keyIds  = new Set(body.nodes.filter((n) => !n.data.node_type).map((n) => n.data.id))
    const badEdge = body.edges.find(
      (e) => e.data.target === hubId && keyIds.has(e.data.source),
    )
    expect(badEdge).toBeUndefined()
  })
})

describe('GET /api/graph — domain-filtered (2-level, hub = topic)', () => {
  it('emits no topic intermediate nodes when ?domain= is set', async () => {
    const pool = makeMockPool(DB_ROWS_SINGLE_TOPIC)
    const { status, body } = await fetchGraph(pool, '?domain=auth')
    expect(status).toBe(200)
    const topicNodes = body.nodes.filter((n) => n.data.node_type === 'topic')
    expect(topicNodes).toHaveLength(0)
  })

  it('key nodes connect directly to hub in domain-filtered view', async () => {
    const pool = makeMockPool(DB_ROWS_SINGLE_TOPIC)
    const { body } = await fetchGraph(pool, '?domain=auth')
    const hubId = body.nodes.find((n) => n.data.node_type === 'hub').data.id
    expect(hubId).toBe('domain:auth')
    const keyEdge = body.edges.find((e) => e.data.source === 'auth:oauth-flow:1')
    expect(keyEdge.data.target).toBe('domain:auth')
  })
})
