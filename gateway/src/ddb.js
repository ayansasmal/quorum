/**
 * Quorum Gateway — DynamoDB membership layer.
 *
 * After v0.3: DynamoDB `quorum-user-projects` is the permanent source of truth for
 * project membership. The former `quorum-configs` cache table is retired — Redis now
 * serves that role (see config-cache.js).
 *
 * Table: quorum-user-projects
 *   PK: github_username   SK: project_id
 *   GSI: ProjectMembersIndex (PK: project_id, SK: github_username)
 *
 * All exported functions are async and never throw on infrastructure errors —
 * DDB is a cache layer. Callers fall through to S3/DB on error.
 */

import {
  DynamoDBClient,
  QueryCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

const USER_PROJECTS_TABLE = process.env.QUORUM_DDB_USER_PROJECTS_TABLE ?? 'quorum-user-projects'
const GSI_NAME            = 'ProjectMembersIndex'

let ddbClient = null

/**
 * Lazy DynamoDBClient singleton.
 * @returns {DynamoDBClient}
 */
function getDdb() {
  if (!ddbClient) {
    const endpoint = process.env.AWS_ENDPOINT_URL
    ddbClient = new DynamoDBClient({
      region:      process.env.AWS_REGION ?? 'us-east-1',
      endpoint:    endpoint || undefined,
      credentials: endpoint
        ? {
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID     ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          }
        : undefined,
    })
  }
  return ddbClient
}

/**
 * List the projects a GitHub user belongs to.
 * @param {string} githubUsername
 * @returns {Promise<Array<{project_id, project_name, project_slug, role, team, base_confidence, is_owner}>>}
 */
export async function getUserProjects(githubUsername) {
  try {
    const result = await getDdb().send(new QueryCommand({
      TableName: USER_PROJECTS_TABLE,
      KeyConditionExpression: '#u = :u',
      ExpressionAttributeNames:  { '#u': 'github_username' },
      ExpressionAttributeValues: marshall({ ':u': githubUsername }),
    }))
    return (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw)
      return {
        project_id:      item.project_id,
        project_name:    item.project_name      ?? null,
        project_slug:    item.project_slug      ?? null,
        role:            item.role              ?? null,
        team:            item.team              ?? null,
        base_confidence: item.base_confidence   ?? null,
        is_owner:        item.is_owner          ?? false,
      }
    })
  } catch (err) {
    console.error(`[Gateway] ddb.getUserProjects(${githubUsername}) failed: ${err.message}`)
    return []
  }
}

/**
 * Chunk an array into fixed-size groups (respects DDB BatchWriteItem 25-item limit).
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Sync the membership table for a given project.
 * Upserts all incoming members; removes members no longer in the list.
 * Idempotent — safe to call repeatedly with the same input.
 *
 * @param {string} projectId
 * @param {string} projectName
 * @param {string} projectSlug
 * @param {Array<{github_username, role, team, base_confidence, is_owner?}>} members
 * @returns {Promise<{added: number, removed: number}>}
 */
export async function syncProjectMembers(projectId, projectName, projectSlug, members) {
  try {
    // 1. Existing members for this project (via GSI)
    const existing = new Set()
    let lastEvaluatedKey
    do {
      const result = await getDdb().send(new QueryCommand({
        TableName: USER_PROJECTS_TABLE,
        IndexName: GSI_NAME,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames:  { '#p': 'project_id' },
        ExpressionAttributeValues: marshall({ ':p': projectId }),
        ExclusiveStartKey: lastEvaluatedKey,
      }))
      for (const raw of result.Items ?? []) {
        const item = unmarshall(raw)
        if (item.github_username) existing.add(item.github_username)
      }
      lastEvaluatedKey = result.LastEvaluatedKey
    } while (lastEvaluatedKey)

    // 2. Diff
    const incomingUsernames = new Set(
      (members ?? []).map((m) => m.github_username).filter(Boolean),
    )
    const toAdd    = (members ?? []).filter((m) => m.github_username)
    const toRemove = [...existing].filter((u) => !incomingUsernames.has(u))

    const updatedAt = new Date().toISOString()
    const writes = [
      ...toAdd.map((m) => ({
        PutRequest: {
          Item: marshall({
            github_username: m.github_username,
            project_id:      projectId,
            project_name:    projectName,
            project_slug:    projectSlug,
            role:            m.role            ?? null,
            team:            m.team            ?? null,
            base_confidence: m.base_confidence ?? 0.5,
            is_owner:        m.is_owner        ?? false,
            updated_at:      updatedAt,
          }, { removeUndefinedValues: true }),
        },
      })),
      ...toRemove.map((username) => ({
        DeleteRequest: {
          Key: marshall({ github_username: username, project_id: projectId }),
        },
      })),
    ]

    for (const batch of chunk(writes, 25)) {
      if (batch.length === 0) continue
      await getDdb().send(new BatchWriteItemCommand({
        RequestItems: { [USER_PROJECTS_TABLE]: batch },
      }))
    }

    return { added: toAdd.length, removed: toRemove.length }
  } catch (err) {
    console.error(`[Gateway] ddb.syncProjectMembers(${projectId}) failed: ${err.message}`)
    return { added: 0, removed: 0 }
  }
}

/**
 * Update the role (and optionally is_owner) for a single member in DDB.
 * Used by POST /config/update-role and POST /config/transfer-ownership.
 *
 * @param {string} githubUsername
 * @param {string} projectId
 * @param {{ role?: string, base_confidence?: number, is_owner?: boolean, team?: string }} updates
 * @returns {Promise<boolean>}
 */
export async function updateMemberRecord(githubUsername, projectId, updates) {
  try {
    const existing = await getUserProjects(githubUsername)
    const current  = existing.find((r) => r.project_id === projectId)
    if (!current) return false

    const merged = {
      github_username: githubUsername,
      project_id:      projectId,
      project_name:    current.project_name    ?? null,
      project_slug:    current.project_slug    ?? null,
      role:            updates.role            ?? current.role,
      team:            updates.team            ?? current.team,
      base_confidence: updates.base_confidence ?? current.base_confidence ?? 0.5,
      is_owner:        updates.is_owner        ?? current.is_owner        ?? false,
      updated_at:      new Date().toISOString(),
    }

    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb')
    await getDdb().send(new PutItemCommand({
      TableName: USER_PROJECTS_TABLE,
      Item:      marshall(merged, { removeUndefinedValues: true }),
    }))
    return true
  } catch (err) {
    console.error(`[Gateway] ddb.updateMemberRecord(${githubUsername}, ${projectId}) failed: ${err.message}`)
    return false
  }
}
