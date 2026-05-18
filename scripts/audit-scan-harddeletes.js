#!/usr/bin/env node
/**
 * Quorum Static Analysis — Graphiti Delete Method Scanner
 *
 * Scans gateway/src/ for direct calls to Graphiti delete/purge methods.
 * Constitutional Rule 1 (no hard deletes) is enforced by blocking these methods
 * in shared/graph/client.js. This scanner ensures no code bypasses that block.
 *
 * Exit 0 — no violations found
 * Exit 1 — violations found
 *
 * Patterns detected:
 *   1. Blocked method names used as string literals in fetch/HTTP calls
 *      (outside shared/graph/client.js where BLOCKED_METHODS is defined)
 *   2. DELETE FROM / DROP TABLE SQL in non-test, non-migration source files
 *   3. deleteEntry / updateEntry called from outside shared/audit/secondary.js
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT        = resolve(import.meta.dirname, '..')
const GATEWAY_SRC = join(ROOT, 'gateway', 'src')

const BLOCKED_GRAPHITI_METHODS = [
  'delete_episode',
  'delete_entity',
  'delete_edge',
  'purge',
  'purge_group',
  'remove',
  'drop',
  'truncate',
]

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
  console.log('Quorum Graphiti Delete Scanner\n' + '─'.repeat(50))
  const allFiles = await collectFiles(GATEWAY_SRC)

  let violations = 0

  // 1. Blocked Graphiti method names in string literals outside client.js + tests
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel === 'gateway/src/shared/graph/client.js') continue
    if (rel === 'gateway/src/shared/governance/constitutional.js') continue
    if (rel.startsWith('tests/')) continue

    for (const method of BLOCKED_GRAPHITI_METHODS) {
      const pattern = new RegExp(`['"\`]${method}['"\`]`, 'g')
      const hits = await findMatches(f, pattern)
      for (const h of hits) {
        console.error(`[BLOCKED_GRAPHITI_METHOD] ${rel}:${h.line}:${h.col}  "${h.text}"  (method '${method}' is constitutionally blocked)`)
        violations++
      }
    }
  }

  // 2. Raw SQL DELETE / DROP in gateway source (not scripts or tests)
  const sqlDeletePattern = /\b(?:DELETE\s+FROM|DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE)\b/i
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel.startsWith('tests/') || rel.startsWith('scripts/') || rel === 'gateway/src/shared/audit/secondary.js') continue
    const hits = await findMatches(f, sqlDeletePattern)
    for (const h of hits) {
      console.error(`[SQL_DELETE] ${rel}:${h.line}:${h.col}  "${h.text}"  (all deletes are unconstitutional — use status transitions instead)`)
      violations++
    }
  }

  // 3. deleteEntry / updateEntry called from outside shared/audit/secondary.js
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    if (rel === 'gateway/src/shared/audit/secondary.js' || rel === 'gateway/src/shared/governance/constitutional.js') continue
    if (rel.startsWith('tests/')) continue
    const hits = await findMatches(f, /(?:deleteEntry|updateEntry)\s*\(/)
    for (const h of hits) {
      console.error(`[AUDIT_MUTATION] ${rel}:${h.line}:${h.col}  "${h.text}"  (audit log is append-only — these functions throw unconditionally)`)
      violations++
    }
  }

  if (violations === 0) {
    console.log('✓ No Graphiti delete violations found')
    process.exit(0)
  } else {
    console.error(`\n✗ ${violations} violation(s) — fix before merging`)
    process.exit(1)
  }
}

main().catch((err) => { console.error('Scanner error:', err.message); process.exit(1) })
