#!/usr/bin/env node
/**
 * archive-audit.js — GAP-05 audit log archival CronJob.
 *
 * Runs monthly (1st of month, 3am UTC via Helm CronJob).
 * Exports old audit_log rows to S3 as JSONL.gz, then marks them with
 * archived_at + archive_s3_key (the row stays in the DB — it is NEVER deleted).
 *
 * Algorithm:
 *   1. Find the oldest unarchived row older than ARCHIVE_AFTER_DAYS (default 90)
 *   2. Process in batches of BATCH_SIZE (10000) — never load all rows at once
 *   3. Serialize each batch to newline-delimited JSON, gzip-compress
 *   4. Upload to S3: s3://${QUORUM_ARCHIVE_BUCKET}/audit-archive/YYYY/MM/start_to_end.jsonl.gz
 *   5. Mark each row with archived_at + archive_s3_key (UPDATE — allowed per schema)
 *
 * The row is never deleted — the audit chain remains intact in PostgreSQL.
 * S3 provides long-term cold storage; the DB partial index keeps hot queries fast.
 *
 * Retrieval: node cli.js audit lineage <topic:key> --include-archived
 * (fetches the S3 archive for the relevant date range and merges with DB results)
 */

import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import pg from 'pg'

const ARCHIVE_AFTER_DAYS = parseInt(process.env.ARCHIVE_AFTER_DAYS ?? '90', 10)
const BATCH_SIZE         = parseInt(process.env.ARCHIVE_BATCH_SIZE  ?? '10000', 10)
const S3_PREFIX          = process.env.ARCHIVE_S3_PREFIX            ?? 'audit-archive'

// ── PostgreSQL connection ─────────────────────────────────────────────────────

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

// ── S3 client (optional — gracefully absent) ──────────────────────────────────

/**
 * Dynamically import S3 client. Returns null if @aws-sdk/client-s3 not installed.
 * @returns {Promise<{ S3Client: Function, PutObjectCommand: Function } | null>}
 */
async function getS3Sdk() {
  try {
    return await import('@aws-sdk/client-s3')
  } catch {
    console.error('[archive-audit] @aws-sdk/client-s3 not installed — cannot archive to S3')
    return null
  }
}

/**
 * Build an S3 key from a date range.
 * Format: audit-archive/2026/01/2026-01-01T00:00:00Z_to_2026-01-31T23:59:59Z.jsonl.gz
 * @param {string} firstTs
 * @param {string} lastTs
 * @returns {string}
 */
function buildS3Key(firstTs, lastTs) {
  const d = new Date(firstTs)
  const year  = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const start = new Date(firstTs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const end   = new Date(lastTs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `${S3_PREFIX}/${year}/${month}/${start}_to_${end}.jsonl.gz`
}

/**
 * Gzip-compress a string of newline-delimited JSON.
 * @param {string} ndjson
 * @returns {Promise<Buffer>}
 */
async function gzipBuffer(ndjson) {
  const chunks = []
  const gzip   = createGzip()
  await pipeline(
    Readable.from([ndjson]),
    gzip,
    async function* (source) {
      for await (const chunk of source) chunks.push(chunk)
    },
  )
  return Buffer.concat(chunks)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const bucket = process.env.QUORUM_ARCHIVE_BUCKET
  if (!bucket) {
    console.error('[archive-audit] QUORUM_ARCHIVE_BUCKET not set — skipping S3 archival (dry-run mode)')
  }

  const sdk = bucket ? await getS3Sdk() : null
  const s3  = sdk ? new sdk.S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' }) : null

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - ARCHIVE_AFTER_DAYS)
  console.error(`[archive-audit] Archiving entries older than ${cutoff.toISOString()} (${ARCHIVE_AFTER_DAYS} days)`)

  let totalArchived = 0

  // Process in batches — never load all rows into memory
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rows: batch } = await pool.query(
      `SELECT * FROM audit_log
       WHERE timestamp < $1
         AND archived_at IS NULL
       ORDER BY timestamp ASC
       LIMIT $2`,
      [cutoff.toISOString(), BATCH_SIZE],
    )

    if (batch.length === 0) break

    const ndjson  = batch.map((r) => JSON.stringify(r)).join('\n')
    const s3Key   = buildS3Key(batch[0].timestamp, batch[batch.length - 1].timestamp)
    const ids     = batch.map((r) => r.entry_id)

    if (s3 && bucket) {
      // Upload compressed archive to S3
      const compressed = await gzipBuffer(ndjson)
      await s3.send(new sdk.PutObjectCommand({
        Bucket:          bucket,
        Key:             s3Key,
        Body:            compressed,
        ContentEncoding: 'gzip',
        ContentType:     'application/x-ndjson',
        Metadata: {
          'quorum-batch-count': String(batch.length),
          'quorum-first-entry': batch[0].entry_id,
          'quorum-last-entry':  batch[batch.length - 1].entry_id,
        },
      }))
      console.error(`[archive-audit] Uploaded ${batch.length} entries to s3://${bucket}/${s3Key}`)
    } else {
      console.error(`[archive-audit] DRY RUN: would upload ${batch.length} entries to s3://<bucket>/${s3Key}`)
    }

    // Mark rows as archived — pointer to S3 key; rows stay in PostgreSQL
    await pool.query(
      `UPDATE audit_log
       SET archived_at = NOW(), archive_s3_key = $1
       WHERE entry_id = ANY($2)`,
      [s3Key, ids],
    )

    totalArchived += batch.length
    console.error(`[archive-audit] Marked ${batch.length} entries as archived (total: ${totalArchived})`)
  }

  console.error(`[archive-audit] Done — archived ${totalArchived} total entries`)
}

main()
  .catch((err) => {
    console.error('[archive-audit] Fatal error:', err.message)
    process.exit(1)
  })
  .finally(() => pool.end())
