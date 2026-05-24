/**
 * mock-openai — Minimal OpenAI API mock for E2E tests.
 *
 * Handles the two endpoints Graphiti/FalkorDB actually calls:
 *   POST /v1/embeddings          — returns a deterministic 1536-dim float vector
 *   POST /v1/chat/completions    — returns a canned assistant response
 *   GET  /health                 — liveness check (used by docker-compose healthcheck)
 *
 * Embedding strategy:
 *   Each input text maps to a deterministic vector derived from SHA-256(text).
 *   The vector is non-zero and unit-normalised, so FalkorDB's cosine-similarity
 *   index can store and query it without NaN/zero-division errors.
 *   Semantically similar texts will NOT produce close vectors — this is intentional:
 *   the E2E tests assert on source/catalog_id annotation, not on semantic ranking.
 *
 * No external npm dependencies — uses only node:http and node:crypto.
 * This keeps the Docker image tiny and the startup time under 200 ms.
 */

import http   from 'node:http'
import crypto from 'node:crypto'

const PORT = 3003

/** Embedding dimension expected by text-embedding-3-small. */
const DIM = 1536

/**
 * Produce a deterministic, normalised float32 embedding for the given text.
 *
 * Algorithm:
 *   1. SHA-256(text) → 32 bytes
 *   2. Stretch to DIM values by cycling through the hash bytes
 *   3. Map each byte to [-1, 1]: (byte / 127.5) - 1
 *   4. L2-normalise the vector so ||v|| = 1 (safe for cosine similarity)
 *
 * @param {string} text
 * @returns {number[]}
 */
function deterministicEmbedding(text) {
  const hash = crypto.createHash('sha256').update(String(text ?? '')).digest()

  // Build raw vector by cycling the 32-byte hash across DIM slots.
  const raw = new Array(DIM)
  for (let i = 0; i < DIM; i++) {
    raw[i] = (hash[i % 32] / 127.5) - 1   // maps [0,255] → [-1, 1]
  }

  // L2-normalise so the vector lies on the unit hypersphere.
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0))
  return norm === 0 ? raw : raw.map(x => x / norm)
}

/**
 * Handle POST /v1/embeddings.
 *
 * Supports both single-string and array-of-strings `input` fields.
 * Returns the OpenAI embedding response envelope.
 *
 * @param {object} body   - Parsed request body
 * @param {http.ServerResponse} res
 */
function handleEmbeddings(body, res) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? '']

  const data = inputs.map((text, idx) => ({
    object:    'embedding',
    index:     idx,
    embedding: deterministicEmbedding(text),
  }))

  const payload = {
    object: 'list',
    data,
    model: body.model ?? 'text-embedding-3-small',
    usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 },
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Handle POST /v1/chat/completions.
 *
 * Returns a benign assistant response. Graphiti uses chat completions for
 * entity extraction and conflict detection — canned responses are enough for
 * E2E tests, which assert on HTTP semantics, not LLM reasoning quality.
 *
 * @param {object} body
 * @param {http.ServerResponse} res
 */
function handleChatCompletions(body, res) {
  // Route to governance-specific responses based on the system prompt content.
  // This allows the gateway's /governance/* endpoints to return well-shaped JSON
  // in the E2E environment without a real OpenAI API key.
  const systemMsg = (body.messages ?? []).find(m => m.role === 'system')?.content ?? ''

  let content
  if (systemMsg.includes('conflict detector')) {
    // governance/detect-conflict: return valid conflict-check shape
    content = JSON.stringify({
      contradicts:      false,
      reason:           'No contradiction detected in test mode.',
      possible_split:   false,
      split_suggestion: null,
    })
  } else if (systemMsg.includes('reviewer brief')) {
    // governance/enrich: return valid enrichment shape
    content = JSON.stringify({
      analysis:               'Mock conflict analysis for E2E test.',
      risks_if_approved:      ['Risk A (test)', 'Risk B (test)'],
      questions_for_reviewer: ['Q1: Is the scope clear?', 'Q2: Does this supersede the existing standard?'],
      existing_rationale:     null,
      possible_split:         false,
      split_suggestion:       null,
    })
  } else if (systemMsg.includes('knowledge extractor')) {
    // governance/extract: return empty items (safe default)
    content = JSON.stringify({ items: [] })
  } else {
    // Graphiti entity extraction — stable generic object Graphiti won't reject
    content = JSON.stringify({
      entities:      [],
      relationships: [],
      summary:       'Mock entity extraction — no real analysis performed in test mode.',
    })
  }

  const payload = {
    id:      `chatcmpl-mock-${Date.now()}`,
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   body.model ?? 'gpt-4o-mini',
    choices: [
      {
        index:         0,
        message:       { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens:     20,
      completion_tokens: 20,
      total_tokens:      40,
    },
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Main request handler.
 * Parses the body, routes to the appropriate handler, returns 404 for unknown paths.
 */
const server = http.createServer((req, res) => {

  // Docker-compose healthcheck
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', service: 'mock-openai' }))
  }

  // Accumulate body
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid_json' }))
    }

    if (req.method === 'POST' && req.url?.includes('/embeddings')) {
      return handleEmbeddings(body, res)
    }

    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      return handleChatCompletions(body, res)
    }

    // Unknown endpoint — return a valid OpenAI-style 404 so callers can log it.
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: { message: `Unknown mock path: ${req.url}`, type: 'not_found' },
    }))
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-openai] listening on port ${PORT}`)
  console.log(`[mock-openai] embedding dimension: ${DIM} (text-embedding-3-small)`)
  console.log('[mock-openai] all responses are deterministic — no real API calls made')
})
