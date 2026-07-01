/**
 * Unified E2E layout contract tests.
 *
 * Task 9 consolidates the API and browser Playwright suites under quorum/e2e/.
 * These assertions lock the target structure and the package-script ownership
 * so future changes do not quietly reintroduce the split test surface.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const QUORUM_ROOT = path.resolve(__dirname, '../..')
const WORKSPACE_ROOT = path.resolve(QUORUM_ROOT, '..')

/**
 * Resolves a path from the Quorum package root.
 *
 * @param {...string} segments - Path segments relative to `quorum/`.
 * @returns {string} Absolute filesystem path.
 */
function quorumPath(...segments) {
  return path.join(QUORUM_ROOT, ...segments)
}

/**
 * Resolves a path from the workspace root.
 *
 * @param {...string} segments - Path segments relative to the workspace root.
 * @returns {string} Absolute filesystem path.
 */
function workspacePath(...segments) {
  return path.join(WORKSPACE_ROOT, ...segments)
}

/**
 * Reads and parses a UTF-8 JSON file.
 *
 * @param {string} filePath - Absolute path to a JSON file.
 * @returns {any} Parsed JSON content.
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

describe('unified E2E layout contract', () => {
  it('keeps the shared E2E suite under quorum/e2e', () => {
    expect(fs.existsSync(quorumPath('e2e', 'playwright.config.js'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'Dockerfile.e2e'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'docker-compose.yml'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'scripts', 'run.sh'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'helpers', 'browser.js'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'fixtures', 'test-private-key.pem'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'scenarios', 'api'))).toBe(true)
    expect(fs.existsSync(quorumPath('e2e', 'scenarios', 'ui'))).toBe(true)
  })

  it('points Quorum E2E scripts at the unified suite', () => {
    const pkg = readJson(quorumPath('package.json'))
    const scripts = pkg.scripts

    expect(scripts['test:e2e']).toContain('e2e/playwright.config.js')
    expect(scripts['test:e2e:env:up']).toBe('sh e2e/scripts/run.sh up')
    expect(scripts['test:e2e:env:setup']).toBe('sh e2e/scripts/run.sh up')
    expect(scripts['test:e2e:env:down']).toBe('sh e2e/scripts/run.sh down')
    expect(scripts['test:e2e:env:clean']).toBe('sh e2e/scripts/run.sh clean')
    expect(scripts['test:e2e:full']).toBe('sh e2e/scripts/run.sh full')
    expect(scripts['test:e2e:docker']).toBe('sh e2e/scripts/run.sh full')
    expect(scripts['test:e2e:docker:logs']).toBe('sh e2e/scripts/run.sh logs')
    expect(scripts).not.toHaveProperty('test:e2e:env:init')
  })

  it('removes dashboard-local E2E script ownership', () => {
    const pkg = readJson(workspacePath('quorum-dash', 'package.json'))
    const scripts = pkg.scripts

    expect(scripts).not.toHaveProperty('test:e2e')
    expect(scripts).not.toHaveProperty('test:e2e:headed')
    expect(scripts).not.toHaveProperty('test:e2e:ui')
    expect(scripts).not.toHaveProperty('test:e2e:report')
    expect(scripts).not.toHaveProperty('test:e2e:docker')
    expect(scripts).not.toHaveProperty('test:e2e:docker:up')
    expect(scripts).not.toHaveProperty('test:e2e:docker:run')
    expect(scripts).not.toHaveProperty('test:e2e:docker:down')
    expect(scripts).not.toHaveProperty('test:e2e:docker:clean')
  })
})
