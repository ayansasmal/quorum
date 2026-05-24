/**
 * Gateway LLM helper — wraps OpenAI Chat Completions API.
 *
 * The gateway is the sole component that holds OPENAI_API_KEY.
 * All MCP LLM calls (conflict detection, enrichment, extraction) route here
 * via the /governance/* endpoints rather than calling OpenAI directly.
 *
 * Uses native Node 20+ fetch — no SDK dependency.
 * Enforces json_object response_format so all responses parse cleanly.
 */

const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '')
const OPENAI_COMPLETIONS_URL = `${OPENAI_BASE}/v1/chat/completions`

/**
 * Call the OpenAI Chat Completions API and return the parsed JSON response body.
 * Throws a structured error with `.status` and `.code` on any failure.
 *
 * @param {{ system: string, user: string }} prompt
 * @returns {Promise<Record<string, unknown>>}
 */
export async function callLLM({ system, user }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not configured on gateway — governance LLM unavailable')
    err.status = 503
    err.code = 'LLM_NOT_CONFIGURED'
    throw err
  }

  const model = process.env.LLM_MODEL_NAME ?? 'gpt-4o-mini'

  const response = await fetch(OPENAI_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ],
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const message = body?.error?.message ?? response.statusText
    const err = new Error(`OpenAI API error (${response.status}): ${message}`)
    err.status = response.status === 429 ? 429 : 502
    err.code = 'LLM_ERROR'
    throw err
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content

  if (!content) {
    const err = new Error('OpenAI returned an empty response')
    err.status = 502
    err.code = 'LLM_EMPTY_RESPONSE'
    throw err
  }

  try {
    return JSON.parse(content)
  } catch {
    const err = new Error(`LLM returned non-JSON content: ${content.slice(0, 120)}`)
    err.status = 502
    err.code = 'LLM_PARSE_ERROR'
    throw err
  }
}
