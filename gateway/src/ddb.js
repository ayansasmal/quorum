/**
 * Quorum Gateway — DynamoDB cache layer.
 *
 * DynamoDB sits in front of S3 as a fast read layer for project configs and
 * user→project membership lookups. S3 remains the source of truth — DDB is
 * populated by:
 *   - read-through on cache miss in config-cache.js
 *   - the POST /sync/configs endpoint (manual + EventBridge scheduled)
 *
 * Two tables:
 *   1. quorum-configs           PK: project_id
 *      Attrs: config (Map), s3_etag (String), updated_at, ttl (Number, 1h)
 *   2. quorum-user-projects     PK: github_username, SK: project_id
 *      GSI: ProjectMembersIndex (PK: project_id, SK: github_username)
 *
 * All exported functions are async and never throw on infrastructure errors
 * — DDB is a cache, not a system of record. Callers fall through to S3/DB.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

const TTL_SECONDS = 3600 // 1 hour cache TTL

const CONFIGS_TABLE       = process.env.QUORUM_DDB_CONFIGS_TABLE       ?? 'quorum-configs'
const USER_PROJECTS_TABLE = process.env.QUORUM_DDB_USER_PROJECTS_TABLE ?? 'quorum-user-projects'
const GSI_NAME            = 'ProjectMembersIndex'

let ddbClient = null

/**
 * Lazy DynamoDBClient singleton.
 * Honours AWS_ENDPOINT_URL (LocalStack) and AWS_REGION exactly like the S3 client.
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
 * Fetch a cached project config from DynamoDB.
 * @param {string} projectId
 * @returns {Promise<object | null>} Parsed config object, or null on miss / error / TTL expiry.
 */
export async function getConfig(projectId) {
  try {
    const result = await getDdb().send(new GetItemCommand({
      TableName: CONFIGS_TABLE,
      Key: marshall({ project_id: projectId }),
    }))
    if (!result.Item) return null

    const item = unmarshall(result.Item)

    // DDB TTL is best-effort — also check ttl client-side to avoid serving stale data
    if (item.ttl && Number(item.ttl) < Math.floor(Date.now() / 1000)) {
      return null
    }
    return item.config ?? null
  } catch (err) {
    console.error(`[Gateway] ddb.getConfig(${projectId}) failed: ${err.message}`)
    return null
  }
}

/**
 * Store a project config in DynamoDB with a 1-hour TTL.
 * @param {string} projectId
 * @param {object} config    The validated config object.
 * @param {string | null} etag S3 ETag (used for staleness checks).
 * @returns {Promise<boolean>} true on success, false on error.
 */
export async function putConfig(projectId, config, etag) {
  try {
    const now = Math.floor(Date.now() / 1000)
    const item = {
      project_id: projectId,
      config,
      s3_etag:    etag ?? null,
      updated_at: new Date().toISOString(),
      ttl:        now + TTL_SECONDS,
    }
    await getDdb().send(new PutItemCommand({
      TableName: CONFIGS_TABLE,
      Item: marshall(item, { removeUndefinedValues: true }),
    }))
    return true
  } catch (err) {
    console.error(`[Gateway] ddb.putConfig(${projectId}) failed: ${err.message}`)
    return false
  }
}

/**
 * List the projects a GitHub user belongs to (queries the user_projects table by PK).
 * @param {string} githubUsername
 * @returns {Promise<Array<{project_id: string, project_name: string, project_slug: string, role: string, team: string, base_confidence: number}>>}
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
      }
    })
  } catch (err) {
    console.error(`[Gateway] ddb.getUserProjects(${githubUsername}) failed: ${err.message}`)
    return []
  }
}

/**
 * Scan the quorum-configs table for projects that have guest_access enabled.
 * Full-table scan — configs table is expected to be small (< 1000 items).
 * Returns best-effort: errors return [] and fall through to S3.
 * @returns {Promise<Array<{ project_id: string, project_name: string | null, project_slug: string | null }>>}
 */
export async function getGuestProjects() {
  try {
    const result = await getDdb().send(new ScanCommand({
      TableName:                 CONFIGS_TABLE,
      FilterExpression:          '#cfg.#ga = :t',
      ExpressionAttributeNames:  { '#cfg': 'config', '#ga': 'guest_access' },
      ExpressionAttributeValues: marshall({ ':t': true }),
    }))
    return (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw)
      return {
        project_id:   item.project_id,
        project_name: item.config?.project  ?? null,
        project_slug: item.config?.group_id ?? item.project_id,
      }
    })
  } catch (err) {
    console.error(`[Gateway] ddb.getGuestProjects() failed: ${err.message}`)
    return []
  }
}

/**
 * Chunk an array into fixed-size groups (used to respect DDB BatchWriteItem 25-item limit).
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
 *
 * Adds (PutRequest) any members in `members` that are not already in DDB,
 * removes (DeleteRequest) any DDB rows for github_usernames that are no longer
 * in the new members list. No hard-deletes of unrelated rows — scope is the
 * single project_id.
 *
 * Idempotent: safe to call repeatedly with the same input.
 *
 * @param {string} projectId
 * @param {string} projectName
 * @param {string} projectSlug
 * @param {Array<{github_username: string, role: string, team: string, base_confidence: number}>} members
 * @returns {Promise<{added: number, removed: number}>}
 */
export async function syncProjectMembers(projectId, projectName, projectSlug, members) {
  try {
    // 1. Existing members in DDB (via GSI)
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

    // 2. Diff against incoming members
    const incomingUsernames = new Set(
      (members ?? [])
        .map((m) => m.github_username)
        .filter(Boolean),
    )
    const toAdd    = (members ?? []).filter((m) => m.github_username) // upsert all incoming
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
            updated_at:      updatedAt,
          }, { removeUndefinedValues: true }),
        },
      })),
      ...toRemove.map((username) => ({
        DeleteRequest: {
          Key: marshall({
            github_username: username,
            project_id:      projectId,
          }),
        },
      })),
    ]

    // 3. BatchWriteItem in chunks of 25 (DDB hard limit)
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
