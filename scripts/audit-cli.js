#!/usr/bin/env node
/**
 * Quorum Ops Audit CLI
 *
 * Ops/compliance tool for auditing the Quorum knowledge store.
 * Uses the gateway HTTP API — no direct database access.
 *
 * Usage:
 *   node scripts/audit-cli.js verify
 *   node scripts/audit-cli.js lineage <topic:key>
 *   node scripts/audit-cli.js export [--from <ISO>] [--to <ISO>]
 *   node scripts/audit-cli.js stats
 *
 * Environment:
 *   QUORUM_GATEWAY_URL    Gateway base URL (default: http://localhost:3001)
 *   QUORUM_GITHUB_TOKEN   GitHub PAT for authentication
 */

import { parseArgs } from 'node:util'
import { verifyChain } from '../gateway/src/shared/audit/chain.js'

// ── Config + auth ─────────────────────────────────────────────────────────────

function gatewayUrl() {
  return process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
}

async function fetchToken() {
  const githubToken = process.env.QUORUM_GITHUB_TOKEN
  if (!githubToken) {
    console.error('Error: QUORUM_GITHUB_TOKEN is not set.')
    process.exit(1)
  }

  const res = await fetch(`${gatewayUrl()}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_token: githubToken }),
  })
  if (!res.ok) {
    console.error(`Auth failed (${res.status}): ${await res.text()}`)
    process.exit(1)
  }
  return (await res.json()).token
}

async function apiFetch(path, token) {
  const res = await fetch(`${gatewayUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    console.error(`Error ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  return res.json()
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdVerify() {
  const token = await fetchToken()
  const entries = await apiFetch('/pg/audit', token)

  if (!entries?.length) {
    console.log('Audit chain: empty (no entries yet)')
    return
  }

  try {
    const result = verifyChain(entries)
    console.log(`✓ Chain integrity: OK (${result.entries} entries verified)`)
  } catch (err) {
    if (err.name === 'ChainIntegrityViolation') {
      console.error(`✗ Chain integrity VIOLATED at position ${err.position}`)
      console.error(`  Expected: ${err.expected}`)
      console.error(`  Actual:   ${err.actual}`)
      process.exit(1)
    }
    throw err
  }
}

async function cmdLineage(topicKey) {
  if (!topicKey) {
    console.error('Usage: audit-cli lineage <topic:key>')
    process.exit(1)
  }
  const [topic, ...keyParts] = topicKey.split(':')
  const key = keyParts.join(':')
  if (!topic || !key) {
    console.error('Usage: audit-cli lineage <topic:key>')
    process.exit(1)
  }

  const token = await fetchToken()
  const { entries } = await apiFetch(
    `/pg/audit/lineage/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`,
    token,
  )

  if (!entries?.length) {
    console.log(`No audit lineage found for ${topicKey}`)
    return
  }

  console.log(`\n${topicKey} — Audit Lineage\n${'─'.repeat(54)}`)
  for (const row of entries) {
    const date = new Date(row.timestamp).toISOString().split('T')[0]
    console.log(
      `[${row.chain_position}] ${String(row.operation).padEnd(15)} v${row.version} ${String(row.link_type).padEnd(10)} @${row.author} ${date}`,
    )
  }
  console.log('')
}

async function cmdExport(from, to) {
  const token = await fetchToken()
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString() ? `?${params}` : ''

  const entries = await apiFetch(`/pg/audit${qs}`, token)
  for (const entry of (entries ?? [])) {
    console.log(JSON.stringify(entry))
  }
}

async function cmdStats() {
  const token = await fetchToken()
  const [{ count }, latest] = await Promise.all([
    apiFetch('/pg/audit/count', token),
    apiFetch('/pg/audit?limit=1&order=desc', token),
  ])

  const entry = Array.isArray(latest) ? latest[0] : null
  console.log('\nQuorum Audit Stats')
  console.log('─'.repeat(40))
  console.log(`Total entries:    ${count}`)
  if (entry) {
    const ts = new Date(entry.timestamp).toISOString()
    console.log(`Latest position:  ${entry.chain_position}`)
    console.log(`Latest entry:     ${ts} by @${entry.author} (${entry.tool})`)
  }
  console.log('')
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: 'string' },
    to:   { type: 'string' },
  },
  allowPositionals: true,
})

const [command, arg1] = positionals

switch (command) {
  case 'verify':
    await cmdVerify()
    break
  case 'lineage':
    await cmdLineage(arg1)
    break
  case 'export':
    await cmdExport(values.from, values.to)
    break
  case 'stats':
    await cmdStats()
    break
  default:
    console.log('Usage: node scripts/audit-cli.js <verify|lineage|export|stats> [options]')
    process.exit(command ? 1 : 0)
}
