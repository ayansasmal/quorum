/**
 * Tests for gateway/src/routes/governance.js
 *
 * POST /governance/detect-conflict
 * POST /governance/enrich
 * POST /governance/extract
 *
 * All LLM calls (callLLM) are mocked — no real OpenAI calls are made.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:  vi.fn(),
}))

vi.mock('../../gateway/src/llm.js', () => ({
  callLLM: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadUserProfile } from '../../gateway/src/config-cache.js'
import { callLLM } from '../../gateway/src/llm.js'
import { loadKeys } from '../../gateway/src/keys.js'
import governanceRoutes from '../../gateway/src/routes/governance.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.locals.pool = { query: vi.fn() }
app.use('/governance', governanceRoutes)
// Error handler matching server.js
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500
  const code   = err.code   ?? 'INTERNAL_ERROR'
  res.status(status).json({ error: code.toLowerCase(), message: err.message })
})

beforeAll(async () => {
  await loadKeys()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeToken(sub = 'alice', is_admin = false) {
  const { privateKey } = await loadKeys()
  return new SignJWT({ sub, is_admin })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

function mockProfile(sub = 'alice') {
  loadUserProfile.mockResolvedValue({
    github_username: sub,
    is_admin:        false,
    projects:        [],
  })
}

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const merged = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: merged },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── POST /governance/detect-conflict ──────────────────────────────────────────

describe('POST /governance/detect-conflict', () => {
  it('returns 401 when no JWT', async () => {
    const { status } = await post('/governance/detect-conflict', {
      existing: 'Use PostgreSQL for persistence',
      incoming: 'Use SQLite for persistence',
    })
    expect(status).toBe(401)
  })

  it('returns 400 when existing is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/detect-conflict',
      { incoming: 'Use SQLite for persistence' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
    expect(body.message).toMatch(/existing/)
  })

  it('returns 400 when incoming is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/detect-conflict',
      { existing: 'Use PostgreSQL for persistence' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
    expect(body.message).toMatch(/incoming/)
  })

  it('returns 400 when existing is empty string', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/detect-conflict',
      { existing: '   ', incoming: 'Use SQLite' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/existing/)
  })

  it('returns contradiction result from LLM', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      contradicts:      true,
      reason:           'PostgreSQL and SQLite cannot both be the primary DB',
      possible_split:   false,
      split_suggestion: null,
    })

    const { status, body } = await post(
      '/governance/detect-conflict',
      {
        existing: 'Use PostgreSQL for all persistence needs',
        incoming: 'Use SQLite for all persistence needs',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.contradicts).toBe(true)
    expect(body.reason).toBe('PostgreSQL and SQLite cannot both be the primary DB')
    expect(body.possible_split).toBe(false)
    expect(body.split_suggestion).toBeNull()
  })

  it('returns split suggestion when LLM says possible_split=true', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      contradicts:      false,
      reason:           'Different scope — prod vs dev',
      possible_split:   true,
      split_suggestion: 'Use PostgreSQL in prod, SQLite in dev',
    })

    const { status, body } = await post(
      '/governance/detect-conflict',
      {
        existing: 'Use PostgreSQL in production',
        incoming: 'Use SQLite in development',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.contradicts).toBe(false)
    expect(body.possible_split).toBe(true)
    expect(body.split_suggestion).toBe('Use PostgreSQL in prod, SQLite in dev')
  })

  it('forwards LLM error to error handler', async () => {
    mockProfile()
    const tok = await makeToken()
    const err = new Error('LLM not configured')
    err.status = 503
    err.code   = 'LLM_NOT_CONFIGURED'
    callLLM.mockRejectedValue(err)

    const { status } = await post(
      '/governance/detect-conflict',
      {
        existing: 'Use PostgreSQL for all persistence needs',
        incoming: 'Use SQLite for all persistence needs',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(503)
  })

  it('normalises non-string reason to empty string', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      contradicts: false,
      reason:      null,  // bad LLM output
      possible_split: false,
    })

    const { status, body } = await post(
      '/governance/detect-conflict',
      {
        existing: 'Use PostgreSQL for all persistence needs',
        incoming: 'Use MySQL for all persistence needs',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.reason).toBe('')
  })
})

// ── POST /governance/enrich ────────────────────────────────────────────────────

describe('POST /governance/enrich', () => {
  it('returns 401 when no JWT', async () => {
    const { status } = await post('/governance/enrich', {
      existing: 'existing knowledge',
      incoming: 'incoming knowledge',
      conflict_reason: 'they conflict',
    })
    expect(status).toBe(401)
  })

  it('returns 400 when existing is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/enrich',
      { incoming: 'incoming', conflict_reason: 'conflict here' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/existing/)
  })

  it('returns 400 when incoming is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/enrich',
      { existing: 'existing', conflict_reason: 'conflict here' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/incoming/)
  })

  it('returns 400 when conflict_reason is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/enrich',
      { existing: 'existing knowledge', incoming: 'incoming knowledge' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/conflict_reason/)
  })

  it('returns enrichment brief from LLM', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      analysis:               'These two statements genuinely contradict each other',
      risks_if_approved:      ['Risk A', 'Risk B'],
      questions_for_reviewer: ['Question 1', 'Question 2'],
      existing_rationale:     'Because of performance requirements',
      possible_split:         false,
      split_suggestion:       null,
    })

    const { status, body } = await post(
      '/governance/enrich',
      {
        existing:        'Use Redis for caching',
        incoming:        'Do not use Redis — use Memcached',
        conflict_reason: 'Contradictory caching strategy',
        possible_split:  false,
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.analysis).toBe('These two statements genuinely contradict each other')
    expect(body.risks_if_approved).toEqual(['Risk A', 'Risk B'])
    expect(body.questions_for_reviewer).toHaveLength(2)
    expect(body.existing_rationale).toBe('Because of performance requirements')
    expect(body.possible_split).toBe(false)
  })

  it('normalises missing LLM arrays to empty arrays', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      analysis: 'Some analysis',
      // risks and questions missing from LLM output
    })

    const { status, body } = await post(
      '/governance/enrich',
      {
        existing:        'Use Redis for all caching purposes',
        incoming:        'Do not use Redis in any context',
        conflict_reason: 'Contradictory caching strategy here',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.risks_if_approved).toEqual([])
    expect(body.questions_for_reviewer).toEqual([])
  })
})

// ── POST /governance/extract ───────────────────────────────────────────────────

describe('POST /governance/extract', () => {
  it('returns 401 when no JWT', async () => {
    const { status } = await post('/governance/extract', { task_summary: 'We implemented JWT auth' })
    expect(status).toBe(401)
  })

  it('returns 400 when task_summary is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/extract',
      {},
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/task_summary/)
  })

  it('returns 400 when task_summary is empty string', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/governance/extract',
      { task_summary: '   ' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/task_summary/)
  })

  it('returns empty items array when LLM extracts nothing', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({ items: [] })

    const { status, body } = await post(
      '/governance/extract',
      { task_summary: 'We fixed a minor typo in the README' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.items).toEqual([])
  })

  it('returns extracted knowledge items from LLM', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({
      items: [
        {
          topic:       'auth',
          key:         'jwt-refresh-strategy',
          content:     'We refresh JWT tokens 5 minutes before expiry',
          entity_type: 'Decision',
          confidence:  0.75,
          mode:        'echoing',
        },
      ],
    })

    const { status, body } = await post(
      '/governance/extract',
      {
        task_summary:   'We implemented proactive JWT refresh 5 minutes before expiry',
        decisions_made: ['Use proactive refresh over reactive re-auth'],
        patterns_used:  ['short-lived tokens'],
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].topic).toBe('auth')
    expect(body.items[0].key).toBe('jwt-refresh-strategy')
    expect(body.items[0].confidence).toBe(0.75)
  })

  it('normalises non-array decisions_made and patterns_used to empty arrays', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({ items: [] })

    const { status } = await post(
      '/governance/extract',
      {
        task_summary:   'Implemented auth feature using standard patterns',
        decisions_made: 'not an array',   // invalid — should be treated as []
        patterns_used:  'also not array', // invalid — should be treated as []
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(callLLM).toHaveBeenCalledOnce()
  })

  it('normalises non-array LLM items to empty array', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({ items: 'bad output' })

    const { status, body } = await post(
      '/governance/extract',
      { task_summary: 'Implemented something important in the codebase' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.items).toEqual([])
  })

  it('forwards constraints array into the LLM prompt user message', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({ items: [] })

    await post(
      '/governance/extract',
      {
        task_summary: 'We chose JWT for auth',
        constraints:  ['do not extract auth patterns', 'skip retry logic'],
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.stringContaining('do not extract auth patterns'),
      }),
    )
  })

  it('normalises non-array constraints to empty (no prompt block)', async () => {
    mockProfile()
    const tok = await makeToken()
    callLLM.mockResolvedValue({ items: [] })

    await post(
      '/governance/extract',
      {
        task_summary: 'We implemented a feature',
        constraints:  'not an array',
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.not.stringContaining('Constraints —'),
      }),
    )
  })
})
