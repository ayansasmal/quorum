/**
 * @file Offline assertions for the rendered production resource graph.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'

/** Cached render output so the composition function runs once per test file. */
let renderedDocuments

/**
 * Renders the production composition.
 *
 * @returns {object[]} Rendered YAML documents.
 */
function render() {
  if (renderedDocuments) return renderedDocuments
  const output = execFileSync('bash', ['crossplane/tests/render.sh'], { encoding: 'utf8' })
  renderedDocuments = yaml.loadAll(output).filter(Boolean)
  return renderedDocuments
}

describe('S-DEPLOY composition render', () => {
  it('renders the expected infrastructure kinds', () => {
    const documents = render()
    const kinds = new Set(documents.map((document) => document.kind))
    for (const kind of [
      'Key', 'VPC', 'Subnet', 'SecurityGroup', 'Bucket', 'Table',
      'Instance', 'EIP', 'Group', 'Role', 'Schedule', 'Budget',
    ]) {
      expect(kinds).toContain(kind)
    }
  }, 30000)

  it('does not expose SSH', () => {
    const serialized = JSON.stringify(render())
    expect(serialized).not.toMatch(/"fromPort":22/)
    expect(serialized).not.toMatch(/"toPort":22/)
  }, 30000)

  it('renders two disabled start schedules and two enabled stop schedules', () => {
    const schedules = render().filter((document) => document.kind === 'Schedule')
    expect(schedules).toHaveLength(4)
    expect(schedules.filter((schedule) => schedule.spec.forProvider.state === 'DISABLED')).toHaveLength(2)
    expect(schedules.filter((schedule) => schedule.spec.forProvider.state === 'ENABLED')).toHaveLength(2)
  }, 30000)
})
