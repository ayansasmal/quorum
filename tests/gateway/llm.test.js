/**
 * Tests for gateway/src/llm.js
 *
 * Uses vi.stubGlobal('fetch') to mock the native fetch API.
 * No real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callLLM } from '../../gateway/src/llm.js'

const PROMPT = { system: 'You are a test assistant', user: 'Say hello' }

// ── Mock fetch globally ────────────────────────────────────────────────────────

let fetchMock

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // Remove key to test the no-key branch separately
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OPENAI_API_KEY
  delete process.env.LLM_MODEL_NAME
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('callLLM', () => {
  it('throws LLM_NOT_CONFIGURED when OPENAI_API_KEY is not set', async () => {
    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 503,
      code:   'LLM_NOT_CONFIGURED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns parsed JSON on success', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    const responseJson = { contradicts: true, reason: 'They conflict' }
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(responseJson) } }],
      }),
    })

    const result = await callLLM(PROMPT)
    expect(result).toEqual(responseJson)
    expect(fetchMock).toHaveBeenCalledOnce()
    // Verify Authorization header is set
    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs[1].headers.Authorization).toBe('Bearer sk-test')
  })

  it('uses custom LLM_MODEL_NAME when set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.LLM_MODEL_NAME = 'gpt-4o'

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"ok": true}' } }],
      }),
    })

    await callLLM(PROMPT)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gpt-4o')
  })

  it('uses gpt-4o-mini as default model', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"ok": true}' } }],
      }),
    })

    await callLLM(PROMPT)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gpt-4o-mini')
  })

  it('throws LLM_ERROR with 429 on rate limit response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok:         false,
      status:     429,
      statusText: 'Too Many Requests',
      json:       vi.fn().mockResolvedValue({ error: { message: 'Rate limit exceeded' } }),
    })

    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 429,
      code:   'LLM_ERROR',
    })
  })

  it('throws LLM_ERROR with 502 on non-429 API error', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok:         false,
      status:     500,
      statusText: 'Internal Server Error',
      json:       vi.fn().mockResolvedValue({}),
    })

    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 502,
      code:   'LLM_ERROR',
    })
  })

  it('uses statusText when error body has no message', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok:         false,
      status:     503,
      statusText: 'Service Unavailable',
      json:       vi.fn().mockResolvedValue({}),
    })

    await expect(callLLM(PROMPT)).rejects.toThrow('Service Unavailable')
  })

  it('throws LLM_EMPTY_RESPONSE when choices[0] is missing content', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: null } }],
      }),
    })

    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 502,
      code:   'LLM_EMPTY_RESPONSE',
    })
  })

  it('throws LLM_EMPTY_RESPONSE when choices array is empty', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [] }),
    })

    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 502,
      code:   'LLM_EMPTY_RESPONSE',
    })
  })

  it('throws LLM_PARSE_ERROR when LLM returns non-JSON content', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'This is not JSON at all, just plain text' } }],
      }),
    })

    await expect(callLLM(PROMPT)).rejects.toMatchObject({
      status: 502,
      code:   'LLM_PARSE_ERROR',
    })
  })

  it('falls back gracefully when error json() itself throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    fetchMock.mockResolvedValue({
      ok:         false,
      status:     500,
      statusText: 'Fallback Text',
      json:       vi.fn().mockRejectedValue(new Error('cannot parse')),
    })

    await expect(callLLM(PROMPT)).rejects.toThrow('Fallback Text')
  })
})
