#!/usr/bin/env node
/**
 * Quorum Static Analysis — Audit Pipeline Bypass Scanner
 *
 * Scans gateway/src/ for patterns that bypass the audit pipeline.
 * Direct INSERT INTO audit_log or writeAuditEntry() calls outside the
 * shared/audit/ directory are constitutional violations.
 *
 * Exit 0 — no violations found
 * Exit 1 — violations found
 *
 * Patterns detected:
 *   1. Direct INSERT INTO audit_log outside gateway/src/shared/audit/secondary.js
 *   2. writeAuditEntry() called from outside the shared/audit/ directory
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT        = resolve(import.meta.dirname, '..')
const GATEWAY_SRC = join(ROOT, 'gateway', 'src')

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
  const allFiles = await collectFiles(GATEWAY_SRC)

  let violations = 0

  // 1. Direct INSERT INTO audit_log — only allowed in shared/audit/secondary.js
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel === 'gateway/src/shared/audit/secondary.js') continue
    const hits = await findMatches(f, /INSERT\s+INTO\s+audit_log/i)
    for (const h of hits) {
      console.error(`[DIRECT_AUDIT_INSERT] ${rel}:${h.line}:${h.col}  "${h.text}"`)
      violations++
    }
  }

  // 2. writeAuditEntry called outside shared/audit/ and authorized callers
  const WRITE_AUDIT_ALLOWLIST = new Set([
    'gateway/src/shared/audit/secondary.js',
    'gateway/src/routes/pg.js',
    'gateway/src/routes/dashboard.js',
  ])
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel.startsWith('gateway/src/shared/audit/') || rel.startsWith('tests/')) continue
    if (WRITE_AUDIT_ALLOWLIST.has(rel)) continue
    const hits = await findMatches(f, /writeAuditEntry\s*\(/)
    for (const h of hits) {
      console.error(`[DIRECT_WRITE_AUDIT] ${rel}:${h.line}:${h.col}  "${h.text}"`)
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
