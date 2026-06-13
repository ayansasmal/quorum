/**
 * @file Offline assertions for the rendered production resource graph.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
      'RolePolicy', 'RolePolicyAttachment', 'EIPAssociation', 'BucketVersioning',
      'BucketServerSideEncryptionConfiguration', 'BudgetAction', 'SecurityGroupRule',
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

  it('uses the explicit production AMI and provider-compatible security group rules', () => {
    /** Rendered production resources. */
    const documents = render()
    /** Canonical production environment input. */
    const environment = yaml.load(readFileSync('crossplane/environments/prod.yaml', 'utf8'))
    /** EC2 application instance. */
    const application = documents.find((document) => (
      document.apiVersion.startsWith('ec2.') && document.kind === 'Instance'
    ))
    /** Combined security group rule resources supported by provider-aws v2.5.0. */
    const rules = documents.filter((document) => document.kind === 'SecurityGroupRule')

    expect(application.spec.forProvider.ami).toBe(environment.spec.compute.amiId)
    expect(application.spec.forProvider.ami).toMatch(/^ami-[0-9a-f]+$/)
    expect(rules).toHaveLength(4)
    expect(documents.some((document) => document.kind === 'SecurityGroupIngressRule')).toBe(false)
    expect(documents.some((document) => document.kind === 'SecurityGroupEgressRule')).toBe(false)
    expect(rules.filter((rule) => rule.spec.forProvider.type === 'ingress')).toHaveLength(3)
    expect(rules.filter((rule) => rule.spec.forProvider.type === 'egress')).toHaveLength(1)
    expect(rules.find((rule) => rule.spec.forProvider.fromPort === 5432)
      .spec.forProvider.sourceSecurityGroupIdSelector.matchLabels)
      .toEqual({ 'quorum.io/security-group': 'app' })
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

  it('renders the membership table with the gateway-compatible key schema and reverse-lookup GSI', () => {
    /** Rendered production resources. */
    const documents = render()
    /** DynamoDB membership table consumed by gateway/src/ddb.js. */
    const membershipTable = documents.find((document) => (
      document.kind === 'Table'
      && document.metadata.annotations?.['crossplane.io/external-name'] === 'quorum-user-projects'
    ))

    expect(membershipTable.spec.forProvider.hashKey).toBe('github_username')
    expect(membershipTable.spec.forProvider.rangeKey).toBe('project_id')
    expect(membershipTable.spec.forProvider.attribute).toEqual([
      { name: 'github_username', type: 'S' },
      { name: 'project_id', type: 'S' },
    ])
    expect(membershipTable.spec.forProvider.globalSecondaryIndex).toEqual([
      {
        name:           'ProjectMembersIndex',
        hashKey:        'project_id',
        rangeKey:       'github_username',
        projectionType: 'ALL',
      },
    ])
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

  it('grants the application instance every DynamoDB operation used by the membership sync', () => {
    /** Rendered production resources. */
    const documents = render()
    /** Inline policy attached to the EC2 application role. */
    const instancePolicyResource = documents.find((document) => (
      document.kind === 'RolePolicy'
      && document.spec.forProvider.roleSelector?.matchLabels?.['quorum.io/role'] === 'instance'
    ))
    /** Parsed IAM policy document. */
    const instancePolicy = JSON.parse(instancePolicyResource.spec.forProvider.policy)
    /** DynamoDB statement used by gateway/src/ddb.js. */
    const dynamodbStatement = instancePolicy.Statement.find((statement) => (
      statement.Action?.some((action) => action.startsWith('dynamodb:'))
    ))

    expect(dynamodbStatement.Action).toEqual(expect.arrayContaining([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:Query',
      'dynamodb:BatchWriteItem',
    ]))
  }, 30000)

  it('targets the configured RDS identifier everywhere', () => {
    /** Rendered production resources. */
    const documents = render()
    /** Canonical production environment input. */
    const environment = yaml.load(readFileSync('crossplane/environments/prod.yaml', 'utf8'))
    /** Environment-specific RDS identifier. */
    const identifier = environment.spec.database.identifier
    /** RDS database instance. */
    const database = documents.find((document) => (
      document.apiVersion.startsWith('rds.') && document.kind === 'Instance'
    ))
    /** RDS EventBridge schedules. */
    const schedules = documents.filter((document) => (
      document.kind === 'Schedule' && document.spec.forProvider.target.arn.includes('rds:')
    ))
    /** Automatic RDS budget stop action. */
    const action = documents.find((document) => document.kind === 'BudgetAction')

    expect(database.metadata.annotations['crossplane.io/external-name']).toBe(identifier)
    expect(database.spec.forProvider.identifier).toBe(identifier)
    expect(schedules).toHaveLength(2)
    expect(schedules.every((schedule) => (
      JSON.parse(schedule.spec.forProvider.target.input).DbInstanceIdentifier === identifier
    ))).toBe(true)
    expect(action.spec.forProvider.definition.ssmActionDefinition.instanceIds).toEqual([identifier])
  }, 30000)
})
