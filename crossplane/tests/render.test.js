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
      'Route', 'RouteTableAssociation', 'SubnetGroup', 'InstanceProfile',
      'RolePolicy', 'EIPAssociation', 'BucketVersioning',
      'BucketServerSideEncryptionConfiguration', 'BudgetAction',
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

  it('wires the public route, database network, instance identity, and elastic IP', () => {
    /** Rendered production resources. */
    const documents = render()
    /** Public IPv4 default route. */
    const route = documents.find((document) => document.kind === 'Route')
    /** RDS database instance. */
    const database = documents.find((document) => (
      document.apiVersion.startsWith('rds.') && document.kind === 'Instance'
    ))
    /** EC2 application instance. */
    const application = documents.find((document) => (
      document.apiVersion.startsWith('ec2.') && document.kind === 'Instance'
    ))

    expect(route.spec.forProvider.destinationCidrBlock).toBe('0.0.0.0/0')
    expect(route.spec.forProvider.gatewayIdSelector.matchControllerRef).toBe(true)
    expect(database.spec.forProvider.dbSubnetGroupNameSelector.matchLabels).toEqual({ 'quorum.io/database': 'prod' })
    expect(database.spec.forProvider.vpcSecurityGroupIdSelector.matchLabels).toEqual({ 'quorum.io/security-group': 'database' })
    expect(application.spec.forProvider.iamInstanceProfile).toBe('quorum-prod-instance')
    expect(documents.filter((document) => document.kind === 'EIPAssociation')).toHaveLength(1)
  }, 30000)

  it('boots the instance from an S3-hosted bootstrap, not an inline blob', () => {
    /** Rendered production resources. */
    const documents = render()
    /** EC2 application instance. */
    const application = documents.find((document) => (
      document.apiVersion.startsWith('ec2.') && document.kind === 'Instance'
    ))
    /** Boot stub passed to the instance. */
    const userData = application.spec.forProvider.userData

    // The stub fetches the orchestrator from the deploy bucket at boot, so bootstrap
    // scripts can be updated and re-run without rebuilding the instance.
    expect(userData).toContain('s3://${DEPLOY_BUCKET}/bootstrap/${BOOTSTRAP_VERSION}/ec2-userdata.sh')
    expect(userData).toContain('exec /opt/quorum/ec2-userdata.sh')
    // No full script embedded as a base64 blob — that would couple updates to a rebuild.
    expect(application.spec.forProvider.userDataBase64).toBeUndefined()
  }, 30000)

  it('renders versioning and KMS encryption for every production bucket', () => {
    /** Rendered production resources. */
    const documents = render()
    /** S3 bucket versioning resources. */
    const versioning = documents.filter((document) => document.kind === 'BucketVersioning')
    /** S3 server-side encryption resources. */
    const encryption = documents.filter((document) => (
      document.kind === 'BucketServerSideEncryptionConfiguration'
    ))

    expect(versioning).toHaveLength(3)
    expect(versioning.every((item) => item.spec.forProvider.versioningConfiguration.status === 'Enabled')).toBe(true)
    expect(encryption).toHaveLength(3)
    expect(encryption.every((item) => (
      item.spec.forProvider.rule[0].applyServerSideEncryptionByDefault.sseAlgorithm === 'aws:kms'
    ))).toBe(true)
  }, 30000)

  it('uses role selectors and an automatic RDS budget stop action', () => {
    /** Rendered production resources. */
    const documents = render()
    /** Serialized render used to detect forbidden placeholders. */
    const serialized = JSON.stringify(documents)
    /** EventBridge Scheduler resources. */
    const schedules = documents.filter((document) => document.kind === 'Schedule')
    /** Automatic AWS Budgets action. */
    const action = documents.find((document) => document.kind === 'BudgetAction')

    expect(serialized).not.toContain('000000000000')
    expect(serialized).not.toContain('"pending"')
    expect(schedules.every((schedule) => schedule.spec.forProvider.target.roleArnSelector)).toBe(true)
    expect(action.spec.forProvider.approvalModel).toBe('AUTOMATIC')
    expect(action.spec.forProvider.definition.ssmActionDefinition.actionSubType).toBe('STOP_RDS_INSTANCES')
  }, 30000)
})
