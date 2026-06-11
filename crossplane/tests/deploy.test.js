/**
 * @file Safety checks for the gated deployment entrypoint.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/** Deployment entrypoint source. */
const source = readFileSync('crossplane/deploy.sh', 'utf8')

describe('S-DEPLOY deployment gate', () => {
  it('defaults to validate', () => {
    expect(source).toContain('COMMAND="${1:-validate}"')
  })

  it('requires typed confirmation for apply and destroy', () => {
    expect(source).toContain('Type yes')
    expect(source).toContain('apply)')
    expect(source).toContain('destroy)')
  })
})
