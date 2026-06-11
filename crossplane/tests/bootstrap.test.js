/**
 * @file Offline validation for production bootstrap and operator shell scripts.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Recursively returns shell scripts below a directory.
 *
 * @param {string} directory Directory to scan.
 * @returns {string[]} Shell script paths.
 */
function shellScripts(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return shellScripts(path)
    return entry.endsWith('.sh') ? [path] : []
  })
}

/** Production scripts validated without executing their behavior. */
const scripts = [
  ...shellScripts('crossplane/bootstrap'),
  ...shellScripts('crossplane/ops'),
  'crossplane/deploy.sh',
].filter(existsSync)

describe('S-DEPLOY bootstrap and ops scripts', () => {
  it('discovers production shell scripts', () => {
    expect(scripts.length).toBeGreaterThan(0)
  })

  for (const script of scripts) {
    it(`${script} passes bash syntax validation`, () => {
      expect(() => execFileSync('bash', ['-n', script])).not.toThrow()
    })

    it(`${script} passes shellcheck`, () => {
      expect(() => execFileSync('shellcheck', ['-x', script])).not.toThrow()
    })
  }
})
