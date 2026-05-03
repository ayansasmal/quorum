#!/usr/bin/env node
/**
 * Quorum CLI — quorum <command>
 *
 * Commands:
 *   init                          Create .quorum project file in current directory
 *   history <topic:key>           Full version timeline
 *   audit verify                  Verify SHA256 audit chain integrity
 *   audit lineage <topic:key>     Full lineage trace for a knowledge node
 *   audit export                  Export audit log (JSONL)
 *   audit stats                   Audit chain statistics
 *   config validate <file>        Validate a local quorum.config.json against the schema
 *   config show                   Show currently loaded config from gateway
 *   projects list                 List projects the authenticated engineer belongs to
 */

import { program } from 'commander'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import pg from 'pg'
import { getAllEntries, countEntries } from './src/audit/secondary.js'
import { verifyChain } from './src/audit/chain.js'
import { handler as historyHandler } from './src/tools/history.js'
import { findQuorumFile, loadQuorumFile, suggestProjectId } from './src/quorum-file.js'

// ── DB connection ──────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'quorum_audit',
  user: process.env.POSTGRES_USER ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

// ── history ────────────────────────────────────────────────────────────────────

program
  .command('history <topicKey>')
  .description('Show full version timeline for a knowledge node (e.g. auth:token-strategy)')
  .action(async (topicKey) => {
    const [topic, ...keyParts] = topicKey.split(':')
    const key = keyParts.join(':')

    if (!topic || !key) {
      console.error('Usage: quorum history <topic:key>')
      process.exit(1)
    }

    try {
      const result = await historyHandler(pool, { topic, key, author: 'cli' })
      if (!result) {
        console.log(`No knowledge found for ${topicKey}`)
      } else {
        console.log(result.formatted ?? JSON.stringify(result, null, 2))
      }
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    } finally {
      await pool.end()
    }
  })

// ── audit verify ──────────────────────────────────────────────────────────────

program
  .command('audit verify')
  .description('Verify SHA256 audit chain integrity')
  .action(async () => {
    try {
      const entries = await getAllEntries(pool)
      if (entries.length === 0) {
        console.log('Audit chain: empty (no entries yet)')
        return
      }
      const result = verifyChain(entries)
      console.log(`✓ Chain integrity: OK (${result.entries} entries verified)`)
    } catch (err) {
      if (err.name === 'ChainIntegrityViolation') {
        console.error(`✗ Chain integrity VIOLATED at position ${err.position}`)
        console.error(`  Expected: ${err.expected}`)
        console.error(`  Actual:   ${err.actual}`)
        process.exit(1)
      }
      console.error('Error:', err.message)
      process.exit(1)
    } finally {
      await pool.end()
    }
  })

// ── audit lineage ─────────────────────────────────────────────────────────────

program
  .command('audit lineage <topicKey>')
  .description('Show full audit lineage for a knowledge node')
  .action(async (topicKey) => {
    const [topic, ...keyParts] = topicKey.split(':')
    const key = keyParts.join(':')

    try {
      const result = await pool.query(
        `SELECT al.entry_id, al.operation, al.author, al.timestamp,
                al.outcome_json, al.governance_json, al.chain_position,
                val.version, val.link_type
         FROM audit_log al
         JOIN version_audit_links val ON al.entry_id = val.audit_entry_id
         WHERE val.topic = $1 AND val.key = $2
         ORDER BY al.chain_position ASC`,
        [topic, key],
      )

      if (result.rows.length === 0) {
        console.log(`No audit lineage found for ${topicKey}`)
        return
      }

      console.log(`\n${topicKey} — Audit Lineage\n${'─'.repeat(54)}`)
      for (const row of result.rows) {
        const date = new Date(row.timestamp).toISOString().split('T')[0]
        console.log(`[${row.chain_position}] ${row.operation.padEnd(15)} v${row.version} ${row.link_type.padEnd(10)} @${row.author} ${date}`)
      }
      console.log('')
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    } finally {
      await pool.end()
    }
  })

// ── audit export ──────────────────────────────────────────────────────────────

program
  .command('audit export')
  .description('Export audit log as JSONL')
  .option('--from <date>', 'Start date (ISO)')
  .option('--to <date>', 'End date (ISO)')
  .option('--format <fmt>', 'Output format: jsonl (default)', 'jsonl')
  .action(async (opts) => {
    try {
      const entries = await getAllEntries(pool, { from: opts.from, to: opts.to })
      for (const entry of entries) {
        console.log(JSON.stringify(entry))
      }
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    } finally {
      await pool.end()
    }
  })

// ── audit stats ───────────────────────────────────────────────────────────────

program
  .command('audit stats')
  .description('Show audit chain statistics')
  .action(async () => {
    try {
      const count = await countEntries(pool)
      const latest = await pool.query(
        'SELECT chain_position, timestamp, author, tool FROM audit_log ORDER BY chain_position DESC LIMIT 1',
      )
      const latest_entry = latest.rows[0]

      console.log('\nQuorum Audit Stats')
      console.log('─'.repeat(40))
      console.log(`Total entries:    ${count}`)
      if (latest_entry) {
        console.log(`Latest position:  ${latest_entry.chain_position}`)
        console.log(`Latest entry:     ${new Date(latest_entry.timestamp).toISOString()} by @${latest_entry.author} (${latest_entry.tool})`)
      }
      console.log('')
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    } finally {
      await pool.end()
    }
  })

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a .quorum project file in the current directory')
  .option('--gateway-url <url>', 'Quorum Gateway URL (can also be set via env QUORUM_GATEWAY_URL)')
  .option('--project-id <id>', 'Project ID for this repository (default: directory name)')
  .option('--yes', 'Skip interactive prompts and use provided options / defaults')
  .action(async (opts) => {
    const targetPath = join(process.cwd(), '.quorum')

    if (existsSync(targetPath)) {
      console.log(`.quorum already exists at ${targetPath}`)
      console.log('Delete it first if you want to re-initialize.')
      process.exit(1)
    }

    let gatewayUrl = opts.gatewayUrl ?? process.env.QUORUM_GATEWAY_URL ?? ''
    let projectId = opts.projectId ?? process.env.QUORUM_PROJECT_ID ?? suggestProjectId()

    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const ask = (q) => new Promise((res) => rl.question(q, res))

      try {
        gatewayUrl = (await ask(`Gateway URL [${gatewayUrl || 'required'}]: `)).trim() || gatewayUrl
        projectId = (await ask(`Project ID [${projectId}]: `)).trim() || projectId
      } finally {
        rl.close()
      }
    }

    if (!gatewayUrl) {
      console.error('Error: gateway_url is required. Pass --gateway-url or set QUORUM_GATEWAY_URL.')
      process.exit(1)
    }

    const content = JSON.stringify({ gateway_url: gatewayUrl, project_id: projectId }, null, 2) + '\n'
    writeFileSync(targetPath, content, 'utf8')

    console.log(`✓ Created .quorum`)
    console.log(`  gateway_url: ${gatewayUrl}`)
    console.log(`  project_id:  ${projectId}`)
    console.log('')
    console.log('Commit this file to your repository so all engineers auto-discover the gateway.')
    console.log('It is safe to commit — it contains no credentials.')
  })

// ── gateway helpers ────────────────────────────────────────────────────────────

/**
 * Resolve gateway URL and project ID from .quorum file or env vars.
 * Exits with an error message if gateway URL is not available.
 * @returns {{ gatewayUrl: string, projectId: string }}
 */
function resolveGatewayConfig() {
  const quorumFile = findQuorumFile()
  const loaded = quorumFile ? loadQuorumFile(quorumFile) : null

  const gatewayUrl = process.env.QUORUM_GATEWAY_URL ?? loaded?.gateway_url ?? ''
  const projectId = process.env.QUORUM_PROJECT_ID ?? loaded?.project_id ?? 'default'

  if (!gatewayUrl) {
    console.error('Error: QUORUM_GATEWAY_URL is not set.')
    console.error('Run `quorum init` to create a .quorum file, or set QUORUM_GATEWAY_URL in your environment.')
    process.exit(1)
  }

  return { gatewayUrl, projectId }
}

/**
 * Fetch a JWT token from the gateway using the QUORUM_GITHUB_TOKEN env var.
 * @param {string} gatewayUrl
 * @returns {Promise<string>} JWT access token
 */
async function fetchToken(gatewayUrl) {
  const githubToken = process.env.QUORUM_GITHUB_TOKEN
  if (!githubToken) {
    console.error('Error: QUORUM_GITHUB_TOKEN is not set.')
    console.error('Set it to a GitHub Personal Access Token so the gateway can verify your identity.')
    process.exit(1)
  }

  const res = await fetch(`${gatewayUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_token: githubToken }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`Error: Gateway auth failed (${res.status}): ${body}`)
    process.exit(1)
  }

  const data = await res.json()
  return data.token
}

// ── config validate ───────────────────────────────────────────────────────────

const configCmd = program.command('config').description('Quorum config management')

configCmd
  .command('validate <file>')
  .description('Validate a local quorum.config.json against the Quorum schema')
  .action(async (file) => {
    const { gatewayUrl } = resolveGatewayConfig()
    const filePath = resolve(file)

    let raw
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.error(`Error reading ${filePath}: ${err.message}`)
      process.exit(1)
    }

    const res = await fetch(`${gatewayUrl}/config/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw),
    })

    const body = await res.json()

    if (res.ok) {
      console.log(`✓ Config is valid (${filePath})`)
      console.log(`  Project:   ${body.project}`)
      console.log(`  Members:   ${body.members}`)
      console.log(`  Roles:     ${body.roles.join(', ')}`)
      console.log(`  Domains:   ${body.domains.join(', ') || '(none)'}`)
    } else {
      console.error(`✗ Config is invalid (${res.status})`)
      if (body.errors) {
        for (const err of body.errors) {
          console.error(`  ${err.path?.join('.') ?? 'root'}: ${err.message}`)
        }
      } else {
        console.error(JSON.stringify(body, null, 2))
      }
      process.exit(1)
    }
  })

// ── config show ───────────────────────────────────────────────────────────────

configCmd
  .command('show')
  .description('Show the currently loaded config for your project (fetched from gateway)')
  .action(async () => {
    const { gatewayUrl, projectId } = resolveGatewayConfig()
    const token = await fetchToken(gatewayUrl)

    const res = await fetch(`${gatewayUrl}/config/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`Error: ${res.status} ${body}`)
      process.exit(1)
    }

    const config = await res.json()
    console.log(JSON.stringify(config, null, 2))
  })

// ── projects list ─────────────────────────────────────────────────────────────

const projectsCmd = program.command('projects').description('Quorum project discovery')

projectsCmd
  .command('list')
  .description('List Quorum projects you are a member of')
  .action(async () => {
    const { gatewayUrl } = resolveGatewayConfig()
    const token = await fetchToken(gatewayUrl)

    const res = await fetch(`${gatewayUrl}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`Error: ${res.status} ${body}`)
      process.exit(1)
    }

    const { projects } = await res.json()

    if (!projects || projects.length === 0) {
      console.log('No projects found. Ask your team lead to add you to the project config in S3.')
      return
    }

    console.log(`\nQuorum Projects (${projects.length})\n${'─'.repeat(40)}`)
    for (const p of projects) {
      const marker = p.project_id === process.env.QUORUM_PROJECT_ID ? ' ←' : ''
      console.log(`  ${p.project_id.padEnd(30)} ${p.member_role ?? ''}${marker}`)
    }
    console.log('')
  })

program.parse()
