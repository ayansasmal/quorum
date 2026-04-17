/**
 * .quorum project file — auto-discovery of gateway URL and project ID.
 *
 * Engineers commit a `.quorum` file to each project repository. When Quorum
 * starts, it walks up the directory tree from `process.cwd()` looking for
 * this file and uses the values found before falling back to env vars.
 *
 * This means `cd my-project && claude` automatically connects to the right
 * Quorum gateway and project without any manual env var configuration.
 *
 * File format:
 * {
 *   "gateway_url": "https://quorum.company.internal",
 *   "project_id": "platform-team"
 * }
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, parse as parsePath } from 'node:path'

const FILENAME = '.quorum'

/**
 * @typedef {Object} QuorumFileConfig
 * @property {string} gateway_url - Quorum Gateway base URL
 * @property {string} project_id  - Project namespace for this repository
 * @property {string} [_source]   - Resolved file path (for diagnostics)
 */

/**
 * Walk up the directory tree from `startDir` looking for a `.quorum` file.
 * Returns the path to the first one found, or null if none exists.
 * @param {string} [startDir=process.cwd()]
 * @returns {string | null}
 */
export function findQuorumFile(startDir = process.cwd()) {
  let current = startDir

  while (true) {
    const candidate = join(current, FILENAME)
    if (existsSync(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return null // filesystem root
    current = parent
  }
}

/**
 * Load and parse the `.quorum` file from `filePath`.
 * Returns null if the file cannot be read or parsed.
 * @param {string} filePath
 * @returns {QuorumFileConfig | null}
 */
export function loadQuorumFile(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))

    if (!raw.gateway_url || !raw.project_id) {
      console.error(`[Quorum] .quorum file at ${filePath} is missing gateway_url or project_id — ignored`)
      return null
    }

    return {
      gateway_url: String(raw.gateway_url).replace(/\/$/, ''), // strip trailing slash
      project_id: String(raw.project_id),
      _source: filePath,
    }
  } catch (err) {
    console.error(`[Quorum] Failed to read .quorum file at ${filePath}: ${err.message}`)
    return null
  }
}

/**
 * Auto-discover the `.quorum` file and apply its values to `process.env`
 * as fallbacks — only if the env vars are not already set.
 *
 * Sets:
 *   QUORUM_GATEWAY_URL   ← gateway_url  (if not set)
 *   QUORUM_PROJECT_ID    ← project_id   (if not set)
 *
 * Call this once at the very start of startup, before any other initialization.
 * @param {string} [startDir]
 * @returns {QuorumFileConfig | null} The config that was applied, or null if no file found
 */
export function applyQuorumFileDefaults(startDir) {
  const filePath = findQuorumFile(startDir)
  if (!filePath) return null

  const cfg = loadQuorumFile(filePath)
  if (!cfg) return null

  if (!process.env.QUORUM_GATEWAY_URL) {
    process.env.QUORUM_GATEWAY_URL = cfg.gateway_url
    console.error(`[Quorum] QUORUM_GATEWAY_URL set from ${filePath}`)
  }
  if (!process.env.QUORUM_PROJECT_ID) {
    process.env.QUORUM_PROJECT_ID = cfg.project_id
    console.error(`[Quorum] QUORUM_PROJECT_ID set from ${filePath}`)
  }

  return cfg
}

/**
 * Determine a sensible `project_id` suggestion for `quorum init`.
 * Uses the current directory name as a slug.
 * @param {string} [dir=process.cwd()]
 * @returns {string}
 */
export function suggestProjectId(dir = process.cwd()) {
  const dirName = parsePath(dir).base
  return dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}
