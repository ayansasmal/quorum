#!/usr/bin/env node
/**
 * Quorum Static Analysis — Audit Pipeline Bypass Scanner
 *
 * Scans src/ for code patterns that bypass the withAuditPipeline wrapper.
 * Every MCP tool operation MUST flow through withAuditPipeline. Direct writes
 * to the audit log or direct pg queries from tool handlers are constitutional
 * violations (Rule 2: append-only audit).
 *
 * Exit 0 — no violations found
 * Exit 1 — violations found (blocks CI)
 *
 * Patterns detected:
 *   1. Direct INSERT INTO audit_log outside audit/secondary.js
 *   2. writeAuditEntry() called from outside audit/ directory
 *   3. pool.query() / pg.query() called directly in src/tools/ files
 *   4. Tool handlers missing the withAuditPipeline wrapper
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MCP_SRC      = join(ROOT, 'mcp', 'src')
const GATEWAY_SRC  = join(ROOT, 'gateway', 'src')

// ── File walker ────────────────────────────────────────────────────────────────

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...await collectFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath)
    }
  }
  return files
}

// ── Scanner ────────────────────────────────────────────────────────────────────

async function findMatches(filePath, pattern) {
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')
    let m
    while ((m = re.exec(lines[i])) !== null) {
      hits.push({ line: i + 1, col: m.index + 1, text: m[0] })
    }
  }
  return hits
}

async function main() {
  console.log('Quorum Audit Bypass Scanner\n' + '─'.repeat(50))
  const allFiles = [
    ...(await collectFiles(MCP_SRC)),
    ...(await collectFiles(GATEWAY_SRC)),
  ]
  try { await stat(join(ROOT, 'mcp', 'cli.js')); allFiles.push(join(ROOT, 'mcp', 'cli.js')) } catch {}

  let violations = 0

  // 1. Direct INSERT INTO audit_log — only allowed in audit/secondary.js
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel === 'mcp/src/audit/secondary.js') continue
    const hits = await findMatches(f, /INSERT\s+INTO\s+audit_log/i)
    for (const h of hits) {
      console.error(`[DIRECT_AUDIT_INSERT] ${rel}:${h.line}:${h.col}  "${h.text}"`)
      violations++
    }
  }

  // 2. writeAuditEntry called outside audit/ and tests/
  // Allowlist: gateway/client.js (proxy method definition) and gateway/routes/pg.js (authorized gateway caller)
  const WRITE_AUDIT_ALLOWLIST = new Set(['mcp/src/gateway/client.js', 'gateway/src/routes/pg.js'])
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel.startsWith('mcp/src/audit/') || rel.startsWith('tests/')) continue
    if (WRITE_AUDIT_ALLOWLIST.has(rel)) continue
    const hits = await findMatches(f, /writeAuditEntry\s*\(/)
    for (const h of hits) {
      console.error(`[DIRECT_WRITE_AUDIT] ${rel}:${h.line}:${h.col}  "${h.text}"`)
      violations++
    }
  }

  // 3. pool.query / pg.query called directly inside src/tools/
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (!rel.startsWith('mcp/src/tools/')) continue
    const hits = await findMatches(f, /(?:pool|pg|client)\.query\s*\(/)
    for (const h of hits) {
      console.error(`[DIRECT_PG_IN_TOOL] ${rel}:${h.line}:${h.col}  "${h.text}"  (use graph/queries.js functions instead)`)
      violations++
    }
  }

  // 4. Tool handler missing withAuditPipeline wrapper
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (!rel.startsWith('mcp/src/tools/')) continue
    const content = await readFile(f, 'utf8')
    if (!/export\s+async\s+function\s+handler/.test(content)) continue
    if (!/withAuditPipeline\s*\(/.test(content)) {
      console.error(`[MISSING_PIPELINE] ${rel}: handler exported without withAuditPipeline wrapper`)
      violations++
    }
  }

  if (violations === 0) {
    console.log('✓ No audit pipeline bypass violations found')
    process.exit(0)
  } else {
    console.error(`\n✗ ${violations} violation(s) — fix before merging`)
    process.exit(1)
  }
}

main().catch((err) => { console.error('Scanner error:', err.message); process.exit(1) })
