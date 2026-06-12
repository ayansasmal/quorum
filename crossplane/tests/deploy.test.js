/**
 * @file Safety checks for the gated deployment entrypoint.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/** Deployment entrypoint source. */
const source = readFileSync('crossplane/deploy.sh', 'utf8')

/** Production AWS ProviderConfig manifest source. */
const providerConfig = readFileSync('crossplane/providers/providerconfig-aws-prod.yaml', 'utf8')

/** Canonical production environment manifest source. */
const productionEnvironment = readFileSync('crossplane/environments/prod.yaml', 'utf8')

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
    expect(source).toContain('kubectl get managed -n "${NAMESPACE}" -o json')
    expect(source).toContain('any(.status.conditions[]?; .type == "Ready" and .status == "True")')
    expect(source).toContain('kubectl get events -n "${NAMESPACE}"')
  })

  it('completes application bootstrap after infrastructure reconciliation', () => {
    const applyBlock = source.slice(source.indexOf('  apply)'), source.indexOf('  status)'))
    const environmentApply = applyBlock.indexOf('environments/prod.yaml')
    const environmentWait = applyBlock.indexOf('kubectl wait --for=condition=Ready')
    const bootstrapUpload = applyBlock.indexOf('upload_bootstrap')
    const bootstrapRun = applyBlock.indexOf('bootstrap_application')

    expect(environmentApply).toBeGreaterThan(-1)
    expect(environmentWait).toBeGreaterThan(environmentApply)
    expect(bootstrapUpload).toBeGreaterThan(environmentWait)
    expect(bootstrapRun).toBeGreaterThan(bootstrapUpload)
    expect(source).toContain('aws ssm send-command')
    expect(source).toContain('aws ssm get-command-invocation')
    expect(source).toContain('Pending|InProgress|Delayed')
    expect(source).toContain('SSM command ${command_id} did not finish within 10 minutes')
    expect(source).toContain('docker exec quorum-gateway-1 node -e')
    expect(source).toContain('response.status === 200')
  })

  it('uses a stable RDS identifier for clean rebuilds', () => {
    expect(productionEnvironment).toContain('identifier: quorum-prod')
    expect(productionEnvironment).not.toContain('identifier: terraform-')
  })

  it('makes destroy idempotent, empties versioned artifacts, and waits for deletion', () => {
    expect(source).toContain('delete_previous_final_snapshot')
    expect(source).toContain('aws rds delete-db-snapshot')
    expect(source).toContain('aws rds wait db-snapshot-deleted')
    expect(source).toContain('delete_deploy_bucket_versions')
    expect(source).toContain('aws s3api list-object-versions')
    expect(source).toContain('aws s3api delete-objects')
    expect(source).toContain('kubectl delete --ignore-not-found')
    expect(source).toContain('wait_for_managed_deletion')
    expect(source).toContain('kubectl wait --for=delete')
    expect(source).toContain('remaining managed resources')
  })
})
