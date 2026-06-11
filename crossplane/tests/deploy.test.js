/**
 * @file Safety checks for the gated deployment entrypoint.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/** Deployment entrypoint source. */
const source = readFileSync('crossplane/deploy.sh', 'utf8')

/** Production AWS ProviderConfig manifest source. */
const providerConfig = readFileSync('crossplane/providers/providerconfig-aws-prod.yaml', 'utf8')

describe('S-DEPLOY deployment gate', () => {
  it('defaults to validate', () => {
    expect(source).toContain('COMMAND="${1:-validate}"')
  })

  it('requires typed confirmation for apply and destroy', () => {
    expect(source).toContain('Type yes')
    expect(source).toContain('apply)')
    expect(source).toContain('destroy)')
  })

  it('uses the namespaced Crossplane v2 AWS ProviderConfig', () => {
    expect(providerConfig).toContain('apiVersion: aws.m.upbound.io/v1beta1')
    expect(providerConfig).toContain('namespace: quorum-system')
    expect(providerConfig).toContain('secretRef:\n      namespace: quorum-system')
    expect(providerConfig).toContain('name: aws-creds-prod')
    expect(providerConfig).toContain('key: creds')

    const namespaceApply = source.indexOf('kubectl create namespace quorum-system')
    const providerConfigApply = source.indexOf('providerconfig-aws-prod.yaml')
    expect(namespaceApply).toBeGreaterThan(-1)
    expect(providerConfigApply).toBeGreaterThan(namespaceApply)
  })

  it('reports the XR, outputs, managed resources, failures, and recent warnings', () => {
    expect(source).toContain('status() {')
    expect(source).toContain('Composite environment')
    expect(source).toContain('Published outputs')
    expect(source).toContain('Managed resources')
    expect(source).toContain('Non-ready details')
    expect(source).toContain('Recent warnings')
    expect(source).toContain('kubectl get managed -n "${namespace}" -o json')
    expect(source).toContain('any(.status.conditions[]?; .type == "Ready" and .status == "True")')
    expect(source).toContain('kubectl get events -n "${namespace}"')
  })
})
