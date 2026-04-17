#!/usr/bin/env node
/**
 * Quorum Static Analysis — Graphiti Delete Method Scanner
 *
 * Scans src/ for direct calls to Graphiti delete/purge methods.
 * Constitutional Rule 1 (no hard deletes) is enforced by blocking these methods
 * in src/graph/client.js. This scanner ensures no code bypasses that block
 * by calling the Graphiti HTTP API directly with a delete tool name.
 *
 * Exit 0 — no violations found
 * Exit 1 — violations found (blocks CI)
 *
 * Patterns detected:
 *   1. Blocked method names used as string literals in fetch/HTTP calls
 *      (outside src/graph/client.js where BLOCKED_METHODS is defined)
 *   2. DELETE FROM / DROP TABLE SQL in non-test, non-migration source files
 *   3. deleteEntry / updateEntry called from outside audit/secondary.js
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC  = join(ROOT, 'src')

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
  const allFiles = await collectFiles(SRC)

  let violations = 0

  // 1. Blocked Graphiti method names in string literals outside client.js + tests
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    // client.js defines BLOCKED_METHODS — allowed to reference them
    if (rel === 'src/graph/client.js') continue
    // constitutional.js defines and enforces the rules — allowed to name the blocked methods
    if (rel === 'src/governance/constitutional.js') continue
    // Tests verify the block is in place — they reference the method names too
    if (rel.startsWith('tests/')) continue

    for (const method of BLOCKED_GRAPHITI_METHODS) {
      // Match the method name used as a string value (in fetch body or tool: param)
      const pattern = new RegExp(`['"\`]${method}['"\`]`, 'g')
      const hits = await findMatches(f, pattern)
      for (const h of hits) {
        console.error(`[BLOCKED_GRAPHITI_METHOD] ${rel}:${h.line}:${h.col}  "${h.text}"  (method '${method}' is constitutionally blocked)`)
        violations++
      }
    }
  }

  // 2. Raw SQL DELETE / DROP in tool and audit source files (not migrations, not tests)
  const sqlDeletePattern = /\b(?:DELETE\s+FROM|DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE)\b/i
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    // Allow in secondary.js — the unconditional-throw functions reference these conceptually
    // Allow in tests and scripts
    if (rel.startsWith('tests/') || rel.startsWith('scripts/') || rel === 'src/audit/secondary.js') continue
    const hits = await findMatches(f, sqlDeletePattern)
    for (const h of hits) {
      console.error(`[SQL_DELETE] ${rel}:${h.line}:${h.col}  "${h.text}"  (all deletes are unconstitutional — use status transitions instead)`)
      violations++
    }
  }

  // 3. deleteEntry / updateEntry called from outside audit/secondary.js
  for (const f of allFiles) {
    const rel = relative(ROOT, f)
    // secondary.js defines these as unconditional-throws; constitutional.js tests that they throw
    if (rel === 'src/audit/secondary.js' || rel === 'src/governance/constitutional.js') continue
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
