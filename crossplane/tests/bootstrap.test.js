/**
 * @file Offline validation for production bootstrap and operator shell scripts.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

  it('installs and verifies the pinned ARM64 Docker Compose plugin', () => {
    /** EC2 user-data source under test. */
    const userData = readFileSync('crossplane/bootstrap/ec2-userdata.sh', 'utf8')

    expect(userData).toContain('COMPOSE_VERSION:=v5.1.4')
    expect(userData).toContain('COMPOSE_ASSET="docker-compose-linux-aarch64"')
    expect(userData).toContain('"${COMPOSE_ASSET}.sha256"')
    expect(userData).toContain('sha256sum -c')
  })

  it('creates author_domain_stats before running its migration guard', () => {
    /** Production database initialization SQL. */
    const schema = readFileSync('crossplane/bootstrap/init-db.sql', 'utf8')
    /** First position of the table creation statement. */
    const createPosition = schema.indexOf('CREATE TABLE IF NOT EXISTS author_domain_stats')
    /** First position of the table migration guard. */
    const alterPosition = schema.indexOf('ALTER TABLE author_domain_stats')

    expect(createPosition).toBeGreaterThan(-1)
    expect(alterPosition).toBeGreaterThan(createPosition)
  })

  it('applies the database schema before starting containers', () => {
    /** Production stack startup source under test. */
    const start = readFileSync('crossplane/bootstrap/start.sh', 'utf8')

    expect(start).toContain('.value | @sh')
    expect(start).toContain('docker login ghcr.io')
    expect(start).toContain('--password-stdin')
    expect(start.indexOf('--file /opt/quorum/init-db.sql')).toBeLessThan(
      start.indexOf('docker compose -f /opt/quorum/docker-compose.aws.yml up -d'),
    )
  })
})
