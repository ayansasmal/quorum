/**
 * @file Validates the backend-only production Docker Compose model.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'

/** Dummy environment used only for Compose interpolation. */
const environment = {
  ...process.env,
  IMAGE_REGISTRY: 'ghcr.io/example',
  GATEWAY_TAG: 'test',
  GRAPHITI_TAG: 'test',
  AWS_REGION: 'ap-southeast-2',
  LOG_GROUP: '/quorum/test',
  ACME_EMAIL: 'operator@example.com',
  QUORUM_ENV_FILE: 'quorum.env.example',
}

/**
 * Produces the normalized Compose model.
 *
 * @returns {object} Parsed Compose configuration.
 */
function composeConfig() {
  const output = execFileSync(
    'docker',
    ['compose', '-f', 'crossplane/bootstrap/docker-compose.aws.yml', '--profile', 'jobs', 'config'],
    { encoding: 'utf8', env: environment },
  )
  return yaml.load(output)
}

describe('S-DEPLOY production compose stack', () => {
  it('contains backend, proxy, and one-shot job services', () => {
    const services = Object.keys(composeConfig().services)
    for (const service of [
      'caddy', 'gateway', 'graphiti', 'falkordb', 'redis',
      'decay-job', 'archive-job', 'recheck-job',
    ]) {
      expect(services).toContain(service)
    }
  })

  it('excludes localstack and dashboard services', () => {
    const services = Object.keys(composeConfig().services)
    expect(services).not.toContain('localstack')
    expect(services.some((service) => service.includes('dashboard'))).toBe(false)
  })

  it('mounts the AWS RDS CA bundle into every gateway-based service', () => {
    /** Normalized production Compose services. */
    const services = composeConfig().services
    /** Gateway image services that connect to PostgreSQL. */
    const gatewayServices = ['gateway', 'decay-job', 'archive-job', 'recheck-job']

    for (const service of gatewayServices) {
      expect(services[service].volumes).toContainEqual(expect.objectContaining({
        source: '/etc/quorum/rds-global-bundle.pem',
        target: '/etc/quorum/rds-global-bundle.pem',
        read_only: true,
      }))
    }
  })
})
