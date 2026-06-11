/**
 * @file Validates the canonical production XR against the XRD schema.
 */
import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

/**
 * Extracts the v1alpha1 spec schema.
 *
 * @returns {object} OpenAPI schema for the XR spec.
 */
function specSchema() {
  const xrd = yaml.load(readFileSync('crossplane/apis/environment/definition.yaml', 'utf8'))
  const version = xrd.spec.versions.find((candidate) => candidate.name === 'v1alpha1')
  return version.schema.openAPIV3Schema.properties.spec
}

/**
 * Loads an isolated copy of the canonical production spec.
 *
 * @returns {object} Production XR spec.
 */
function prodSpec() {
  return yaml.load(readFileSync('crossplane/environments/prod.yaml', 'utf8')).spec
}

/** AJV instance configured for Kubernetes OpenAPI-compatible validation. */
const ajv = new Ajv({ allErrors: true, strict: false })

describe('S-DEPLOY XRD input schema', () => {
  it('accepts the canonical production XR', () => {
    const validate = ajv.compile(specSchema())
    expect(validate(prodSpec()), JSON.stringify(validate.errors)).toBe(true)
  })

  it.each([
    ['environment', (spec) => { spec.environment = 'staging' }],
    ['region', (spec) => { spec.region = 'us-east-1' }],
    ['architecture', (spec) => { spec.compute.arch = 'x86_64' }],
    ['capacity type', (spec) => { spec.compute.capacityType = 'spot' }],
    ['email', (spec) => { spec.budget.notifyEmail = 'invalid' }],
  ])('rejects an invalid %s', (_name, mutate) => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    mutate(spec)
    expect(validate(spec)).toBe(false)
  })

  it('rejects a missing database block', () => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    delete spec.database
    expect(validate(spec)).toBe(false)
  })
})
