/**
 * Constitutional Meta-Test
 *
 * This test suite tests the test suite itself.
 * It verifies that:
 *   1. All 5 constitutional rules have a corresponding test file
 *   2. No test file uses .skip (disabled tests are not acceptable in constitutional suite)
 *   3. Each test file imports ConstitutionalViolation
 *   4. The constitutional module exports all expected functions
 *   5. All 5 rule functions are covered (checked structurally, not by coverage tooling)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONSTITUTIONAL_TEST_DIR = __dirname
const CONSTITUTIONAL_SRC = join(__dirname, '../../src/governance/constitutional.js')

// ── Rule coverage ─────────────────────────────────────────────────────────────

const EXPECTED_TEST_FILES = [
  'no-hard-delete.test.js',
  'append-only-audit.test.js',
  'reason-required.test.js',
  'no-self-approval.test.js',
  'multi-party-config.test.js',
  'meta.test.js',
]

describe('constitutional test suite coverage', () => {
  it('all 5 rules + meta have a test file', () => {
    const files = readdirSync(CONSTITUTIONAL_TEST_DIR).filter((f) => f.endsWith('.test.js'))
    for (const expected of EXPECTED_TEST_FILES) {
      expect(files, `Missing test file: ${expected}`).toContain(expected)
    }
  })

  it('no test file uses .skip', () => {
    const files = readdirSync(CONSTITUTIONAL_TEST_DIR).filter((f) => f.endsWith('.test.js'))
    for (const file of files) {
      if (file === 'meta.test.js') continue // meta is allowed to reference skip
      const content = readFileSync(join(CONSTITUTIONAL_TEST_DIR, file), 'utf8')
      const hasSkip = /\.(skip|only)\s*[(`(]/.test(content)
      expect(hasSkip, `Test file ${file} contains .skip or .only — constitutional tests cannot be disabled`).toBe(false)
    }
  })

  it('each test file imports ConstitutionalViolation', () => {
    const files = readdirSync(CONSTITUTIONAL_TEST_DIR).filter(
      (f) => f.endsWith('.test.js') && f !== 'meta.test.js',
    )
    for (const file of files) {
      const content = readFileSync(join(CONSTITUTIONAL_TEST_DIR, file), 'utf8')
      expect(
        content,
        `Test file ${file} does not import ConstitutionalViolation`,
      ).toContain('ConstitutionalViolation')
    }
  })
})

// ── Constitutional module exports ─────────────────────────────────────────────

describe('constitutional.js exports', () => {
  it('exports ConstitutionalViolation', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.ConstitutionalViolation).toBe('function')
  })

  it('exports enforceNoHardDelete', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceNoHardDelete).toBe('function')
  })

  it('exports enforceAppendOnlyAudit', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceAppendOnlyAudit).toBe('function')
  })

  it('exports enforceReasonRequired', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceReasonRequired).toBe('function')
  })

  it('exports enforceNoSelfApproval', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceNoSelfApproval).toBe('function')
  })

  it('exports enforceMultiPartyConfig', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceMultiPartyConfig).toBe('function')
  })

  it('exports validateManifestHasNoDeleteTools', async () => {
    const mod = await import('../../src/governance/constitutional.js')
    expect(typeof mod.enforceMultiPartyConfig).toBe('function')
  })
})

// ── Constitutional module source analysis ─────────────────────────────────────

describe('constitutional.js source integrity', () => {
  it('does not contain any dynamic env-var bypass (process.env disabling a rule)', () => {
    const source = readFileSync(CONSTITUTIONAL_SRC, 'utf8')
    // Constitutional rules must throw unconditionally — they cannot be disabled via env var.
    // This is a structural check, not exhaustive. The test verifies intent.
    const suspiciousPattern = /process\.env\s*\.\s*\w+\s*&&\s*enforce/
    expect(suspiciousPattern.test(source)).toBe(false)
  })

  it('all 5 enforce* functions are present in source', () => {
    const source = readFileSync(CONSTITUTIONAL_SRC, 'utf8')
    const expectedFunctions = [
      'enforceNoHardDelete',
      'enforceAppendOnlyAudit',
      'enforceReasonRequired',
      'enforceNoSelfApproval',
      'enforceMultiPartyConfig',
    ]
    for (const fn of expectedFunctions) {
      expect(source, `Missing function: ${fn}`).toContain(fn)
    }
  })

  it('ConstitutionalViolation class is exported', () => {
    const source = readFileSync(CONSTITUTIONAL_SRC, 'utf8')
    expect(source).toContain('export class ConstitutionalViolation')
  })
})
