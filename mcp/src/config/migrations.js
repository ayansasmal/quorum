/**
 * JSONB config migration loader (GAP-30).
 *
 * As Quorum evolves, new fields are added to the `projects.governance` JSONB column.
 * Existing project rows have stale JSONB — new fields are missing.
 *
 * applyMigrations() runs on every project config read. It is idempotent:
 *   - Migrations with version ≤ project.schema_version are skipped.
 *   - Only runs DB write-back when the schema_version actually advances.
 *   - Returns the fully migrated project shape regardless of whether a write occurred.
 *
 * Adding a new migration:
 *   1. Append a new object to MIGRATIONS with the next version number.
 *   2. The `up` function receives the full project JSONB shape and returns the upgraded shape.
 *   3. Existing fields always take precedence (spread existing AFTER defaults).
 */

/**
 * @typedef {{ version: number, description: string, up: (project: Record<string, unknown>) => Record<string, unknown> }} Migration
 */

/**
 * Ordered list of versioned schema migrations.
 * Version numbers must be consecutive and start at 2.
 *
 * @type {Migration[]}
 */
export const MIGRATIONS = [
  // v1 → v2: add governance.bump_cooldown_days (GAP-24 confidence bump mechanic)
  {
    version: 2,
    description: 'Add governance.bump_cooldown_days (default 7)',
    up: (project) => ({
      ...project,
      governance: {
        bump_cooldown_days: 7,     // new field — default value
        ...project.governance,     // existing fields take precedence
      },
    }),
  },
  // v2 → v3: add governance.notification_poll_minutes (dashboard polling interval)
  {
    version: 3,
    description: 'Add governance.notification_poll_minutes (default 60)',
    up: (project) => ({
      ...project,
      governance: {
        notification_poll_minutes: 60,
        ...project.governance,
      },
    }),
  },
  // Add new migrations here — increment version, write an up() transform
]

/**
 * Apply all pending schema migrations to a project row loaded from the database.
 *
 * Writes back to the `projects` table if any migrations ran, so subsequent reads
 * at the same schema_version are no-ops. Swallows write-back errors — callers
 * always receive the migrated shape even if the write fails.
 *
 * @param {Record<string, unknown>} project - Raw project row from the DB
 * @param {import('pg').Pool | null} [pg] - PostgreSQL pool; if null, no write-back occurs
 * @returns {Promise<Record<string, unknown>>} Fully migrated project row
 */
export async function applyMigrations(project, pg = null) {
  let current = { ...project }
  let version = current.schema_version ?? 1

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue   // already applied
    current = migration.up(current)
    version = migration.version
  }

  // Write back only if schema_version actually advanced
  if (version > (project.schema_version ?? 1) && pg) {
    try {
      await pg.query(
        `UPDATE projects
         SET governance = $1, schema_version = $2
         WHERE id = $3`,
        [JSON.stringify(current.governance), version, current.id],
      )
      console.error(`[Quorum:migrations] Project ${current.id} migrated to schema_version ${version}`)
    } catch (err) {
      // Non-fatal — return the migrated shape even if the write-back fails
      console.error(`[Quorum:migrations] Write-back failed for project ${current.id}: ${err.message}`)
    }
  }

  return { ...current, schema_version: version }
}
