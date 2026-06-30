/**
 * Local Graphiti image contract tests.
 *
 * Local Docker Compose, isolated E2E, and Docker Desktop Kubernetes must all
 * consume the GHCR-published Graphiti image built from the local
 * graphiti/quorum-graphiti checkout instead of rebuilding Dockerfile.graphiti
 * inside this repository.
 */

import fs from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Reads a YAML document relative to the Quorum repo root.
 *
 * @param {string} relativePath - Repository-relative file path.
 * @returns {any} Parsed YAML document.
 */
function readYaml(relativePath) {
  const fileUrl = new URL(`../../${relativePath}`, import.meta.url)
  return yaml.load(fs.readFileSync(fileUrl, 'utf8'))
}

/**
 * Reads a UTF-8 text file relative to the Quorum repo root.
 *
 * @param {string} relativePath - Repository-relative file path.
 * @returns {string} File contents.
 */
function readText(relativePath) {
  const fileUrl = new URL(`../../${relativePath}`, import.meta.url)
  return fs.readFileSync(fileUrl, 'utf8')
}

describe('local Graphiti image contract', () => {
  it('uses the published GHCR image for local Docker Compose', () => {
    const compose = readYaml('docker-compose.yml')
    const graphiti = compose.services.graphiti

    expect(graphiti.image).toContain('ghcr.io/ayansasmal/graphiti-mcp')
    expect(graphiti.image).toContain('GRAPHITI_TAG')
    expect(graphiti.build).toBeUndefined()
  })

  it('uses the published GHCR image for isolated E2E Docker Compose', () => {
    const compose = readYaml('docker-compose.e2e.yml')
    const graphiti = compose.services.graphiti

    expect(graphiti.image).toContain('ghcr.io/ayansasmal/graphiti-mcp')
    expect(graphiti.image).toContain('GRAPHITI_TAG')
    expect(graphiti.build).toBeUndefined()
  })

  it('configures local k8s to pull Graphiti from GHCR instead of building it', () => {
    const values = readYaml('helm/quorum/values.yaml')
    const script = readText('scripts/k8s-setup.sh')

    expect(values.graphiti.image.repository).toBe('ghcr.io/ayansasmal/graphiti-mcp')
    expect(script).not.toContain('Dockerfile.graphiti')
    expect(script).not.toContain('graphiti-mcp:local')
    expect(script).toContain('graphiti.image.repository=')
    expect(script).toContain('graphiti.image.tag=')
  })
})
