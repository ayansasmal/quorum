/**
 * Authority scoring (GAP-18).
 *
 * Score formula (configurable weights, defaults below):
 *   authority = (confidence × 0.35) + (recency × 0.25) + (access_frequency × 0.20) + (role × 0.20)
 *
 * where:
 *   confidence       = stored confidence score (0–1)
 *   recency          = exp(-AGE_DECAY × days_since_created)
 *   access_frequency = log1p(access_count) / 10   (capped contribution)
 *   role             = ROLE_SCORES[author_role] ?? 0.50
 *
 * Role gate: an engineer-authored entry can NEVER auto-supersede an
 * architect or principal_architect entry — always routes to human review.
 * This is a hard check, applied before the score delta comparison.
 *
 * Role-based confidence floor (v0.2):
 *   When a caller-provided confidence is below the role's base_confidence floor,
 *   the floor is used instead. Spoofing is architecturally impossible — author
 *   is resolved server-side, never accepted from tool input.
 */

import { getConfig } from '../config/loader.js'

const AGE_DECAY          = parseFloat(process.env.QUORUM_AGE_DECAY          ?? '0.01')
const AUTHORITY_THRESHOLD = parseFloat(process.env.QUORUM_AUTHORITY_THRESHOLD ?? '0.20')

/** Default role scores — overridable per project via governance.authority.role_scores */
const DEFAULT_ROLE_SCORES = {
  engineer:             0.50,
  senior_engineer:      0.70,
  tech_lead:            0.70,
  architect:            0.80,
  principal_architect:  1.00,
}

/** Default formula weights — overridable via governance.authority.weights */
const DEFAULT_WEIGHTS = {
  confidence:          0.30,   // was 0.35 before GAP-21
  recency:             0.22,   // was 0.25 before GAP-21
  access_frequency:    0.18,   // was 0.20 before GAP-21
  role:                0.18,   // was 0.20 before GAP-21
  domain_track_record: 0.12,   // GAP-21: demonstrated expertise in the domain
}

/**
 * Role tiers used by the gate. An entry authored by a LOWER tier can never
 * auto-supersede one authored by a HIGHER tier.
 */
const ROLE_TIER = {
  engineer:             1,
  senior_engineer:      2,
  tech_lead:            2,
  architect:            3,
  principal_architect:  4,
}

/**
 * Days elapsed since a given date string.
 * @param {string | Date} date
 * @returns {number}
 */
function daysSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)
}

/**
 * Resolve role score for an author_role string.
 * Falls back to 0.50 (engineer baseline) for unknown roles.
 * @param {string | undefined} role
 * @param {object} [projectRoleScores]
 * @returns {number}
 */
function roleScore(role, projectRoleScores) {
  const scores = { ...DEFAULT_ROLE_SCORES, ...(projectRoleScores ?? {}) }
  return scores[role ?? 'unknown'] ?? 0.50
}

/**
 * Load project-level authority config (weights + role_scores) from the config.
 * Falls back to defaults if config is not loaded or the project has no overrides.
 * @returns {{ weights: object, roleScores: object }}
 */
function loadAuthorityConfig() {
  try {
    const config = getConfig()
    const authority = config?.governance?.authority ?? {}
    return {
      weights:    { ...DEFAULT_WEIGHTS,     ...(authority.weights    ?? {}) },
      roleScores: { ...DEFAULT_ROLE_SCORES, ...(authority.role_scores ?? {}) },
    }
  } catch {
    return { weights: DEFAULT_WEIGHTS, roleScores: DEFAULT_ROLE_SCORES }
  }
}

/**
 * Calculate the composite authority score for a knowledge episode.
 *
 * @param {{
 *   confidence?: number,
 *   created_at: string | Date,
 *   access_count?: number,
 *   author_role?: string,
 *   domain_track_record?: { approved_count?: number, recalled_count?: number, superseded_count?: number }
 * }} episode
 * @returns {number} score between 0 and 1
 */
export function calculateAuthority(episode) {
  const { weights, roleScores } = loadAuthorityConfig()

  const confidence = episode.confidence ?? 0.5
  const recency    = Math.exp(-AGE_DECAY * daysSince(episode.created_at))
  const access     = Math.log1p(episode.access_count ?? 0) / 10
  const role       = roleScore(episode.author_role, roleScores)

  // GAP-21: domain track record — normalised to 0–1 via log1p, same pattern as access_frequency.
  // Net endorsement score: approved + recalled signals expertise; superseded signals over-confidence.
  // Floored at 0 so a heavily superseded author doesn't get a negative contribution.
  const dtr = episode.domain_track_record ?? {}
  // Clamp net count to ≥ -1 before log1p: log1p(x) is only real for x ≥ -1, and
  // Math.max(0, NaN) propagates NaN rather than flooring it.
  const netCount = Math.max(-1, (dtr.approved_count ?? 0) + (dtr.recalled_count ?? 0) - (dtr.superseded_count ?? 0))
  const domainScore = Math.max(0, Math.log1p(netCount) / 10)

  return (
    confidence  * weights.confidence +
    recency     * weights.recency +
    access      * weights.access_frequency +
    role        * weights.role +
    domainScore * (weights.domain_track_record ?? 0.12)
  )
}

/**
 * Returns true if the incoming episode has a sufficiently higher authority
 * score than the existing one to warrant automatic supersession.
 *
 * Hard role gate (GAP-18): a lower-tier role can never auto-supersede a
 * higher-tier role — always routes to human review regardless of score delta.
 *
 * @param {{ confidence?: number, created_at: string | Date, access_count?: number, author_role?: string }} incoming
 * @param {{ confidence?: number, created_at: string | Date, access_count?: number, author_role?: string }} existing
 * @returns {boolean}
 */
export function shouldAutoSupersede(incoming, existing) {
  const incomingTier = ROLE_TIER[incoming.author_role ?? 'unknown'] ?? 1
  const existingTier = ROLE_TIER[existing.author_role ?? 'unknown'] ?? 1

  // Hard gate: lower-tier author can never auto-supersede a higher-tier author
  if (incomingTier < existingTier) return false

  const delta = calculateAuthority(incoming) - calculateAuthority(existing)
  return delta > AUTHORITY_THRESHOLD
}

/**
 * Apply the role-based confidence floor from the loaded config.
 *
 * If the caller-provided confidence is below the floor defined for their role,
 * the floor is used instead. Falls back to the identity's base_confidence.
 *
 * @param {number} providedConfidence - Confidence supplied in the tool call (0–1)
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @returns {number} Effective confidence after applying the floor
 */
export function resolveAuthorConfidence(providedConfidence, identity) {
  let floor = identity.base_confidence ?? 0.5

  try {
    const config = getConfig()
    if (identity.role && config.roles[identity.role] !== undefined) {
      floor = config.roles[identity.role].base_confidence
    }
  } catch {
    // Config not loaded yet — use the floor from identity resolution
  }

  return Math.max(providedConfidence, floor)
}
