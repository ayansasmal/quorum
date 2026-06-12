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

  it('mirrors every script run to a timestamped log file', () => {
    for (const script of scripts) {
      /** Source of the script under inspection. */
      const body = readFileSync(script, 'utf8')

      // Each run names its own file with a per-second timestamp, so timer-driven
      // and SSM re-runs stay independently traceable.
      expect(body, `${script} must build a timestamped log file name`).toContain('date +%Y%m%d-%H%M%S')
      expect(body, `${script} must tee stdout and stderr to the log file`).toContain(
        'exec > >(tee -a "${LOG_FILE}") 2>&1',
      )
    }
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

  it('loads static runtime configuration before refreshing RDS credentials', () => {
    /** Production stack startup source under test. */
    const start = readFileSync('crossplane/bootstrap/start.sh', 'utf8')
    /** First load of the application secret-backed environment file. */
    const sourcePosition = start.indexOf('source /etc/quorum/quorum.env')
    /** RDS credential refresh that requires DB_INSTANCE_ID. */
    const refreshPosition = start.indexOf('/opt/quorum/refresh-rds-credentials.sh')

    expect(sourcePosition).toBeGreaterThan(-1)
    expect(sourcePosition).toBeLessThan(refreshPosition)
    expect(start.indexOf('DB_INSTANCE_ID="${QUORUM_DB_INSTANCE_ID:-quorum-prod}"')).toBeGreaterThan(
      sourcePosition,
    )
  })

  it('creates the application database before applying its schema', () => {
    /** Production stack startup source under test. */
    const start = readFileSync('crossplane/bootstrap/start.sh', 'utf8')
    /** Idempotent database creation command. */
    const createPosition = start.indexOf('createdb')
    /** Schema application command. */
    const schemaPosition = start.indexOf('--file /opt/quorum/init-db.sql')

    expect(start).toContain('FROM pg_database')
    expect(start).toContain('^[a-zA-Z_][a-zA-Z0-9_]*$')
    expect(createPosition).toBeGreaterThan(-1)
    expect(createPosition).toBeLessThan(schemaPosition)
  })

  it('installs downloaded systemd units before enabling timers', () => {
    /** Production stack startup source under test. */
    const start = readFileSync('crossplane/bootstrap/start.sh', 'utf8')
    /** Unit installation command. */
    const installPosition = start.indexOf('install -m 0644 /opt/quorum/systemd/* /etc/systemd/system/')
    /** Timer activation command. */
    const enablePosition = start.indexOf('systemctl enable --now quorum-credential-refresh.timer')

    expect(installPosition).toBeGreaterThan(-1)
    expect(installPosition).toBeLessThan(enablePosition)
  })

  it('enables TLS for gateway connections to RDS', () => {
    /** RDS credential refresh source under test. */
    const refresh = readFileSync('crossplane/bootstrap/refresh-rds-credentials.sh', 'utf8')
    /** Production stack startup source under test. */
    const start = readFileSync('crossplane/bootstrap/start.sh', 'utf8')

    expect(refresh).toContain("printf 'POSTGRES_SSL=true")
    expect(refresh).toContain("printf 'NODE_EXTRA_CA_CERTS=/etc/quorum/rds-global-bundle.pem")
    expect(start).toContain('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem')
  })

  it('quotes the generated RDS password for both Bash and Docker Compose', () => {
    /** RDS credential refresh source under test. */
    const refresh = readFileSync('crossplane/bootstrap/refresh-rds-credentials.sh', 'utf8')

    expect(refresh).toContain("PASSWORD_QUOTED=\"$(jq -Rrn --arg value \"${PASSWORD}\" '$value | @sh')\"")
    expect(refresh).toContain("printf 'POSTGRES_PASSWORD=%s")
    expect(refresh).not.toContain("printf 'POSTGRES_PASSWORD=%q")
  })
})
