/**
 * Authority scoring.
 *
 * Determines whether an incoming knowledge write should automatically supersede
 * an existing one, or whether the delta is too small and a human should decide.
 *
 * Score formula:
 *   authority = (confidence × 0.5) + (recency × 0.3) + (access_frequency × 0.2)
 *
 * where:
 *   recency          = exp(-AGE_DECAY × days_since_created)
 *   access_frequency = log1p(access_count) / 10   (capped contribution)
 *
 * Role-based confidence floor (v0.2):
 *   When a caller-provided confidence is below the role's base_confidence floor
 *   from the S3 config, the floor is used instead. This ensures a principal
 *   architect's writes are never scored lower than their role warrants.
 */

import { getConfig } from '../config/loader.js'

const AGE_DECAY = parseFloat(process.env.QUORUM_AGE_DECAY ?? '0.01')
const AUTHORITY_THRESHOLD = parseFloat(process.env.QUORUM_AUTHORITY_THRESHOLD ?? '0.20')

/**
 * Days elapsed since a given date string.
 * @param {string | Date} date
 * @returns {number}
 */
function daysSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)
}

/**
 * Calculate the authority score for a knowledge episode.
 * @param {{ confidence?: number, created_at: string | Date, access_count?: number }} episode
 * @returns {number} score between 0 and 1
 */
export function calculateAuthority(episode) {
  const confidence = episode.confidence ?? 0.5
  const recency = Math.exp(-AGE_DECAY * daysSince(episode.created_at))
  const access = Math.log1p(episode.access_count ?? 0) / 10
  return confidence * 0.5 + recency * 0.3 + access * 0.2
}

/**
 * Returns true if the incoming episode has a sufficiently higher authority
 * score than the existing one to warrant automatic supersession.
 *
 * If delta ≤ AUTHORITY_THRESHOLD, a human should decide.
 *
 * @param {{ confidence?: number, created_at: string | Date, access_count?: number }} incoming
 * @param {{ confidence?: number, created_at: string | Date, access_count?: number }} existing
 * @returns {boolean}
 */
export function shouldAutoSupersede(incoming, existing) {
  const delta = calculateAuthority(incoming) - calculateAuthority(existing)
  return delta > AUTHORITY_THRESHOLD
}

/**
 * Apply the role-based confidence floor from the loaded S3 config.
 *
 * If the caller-provided confidence is below the floor defined for their role,
 * the floor is used instead. If config is not loaded or the role has no entry,
 * falls back to the identity's base_confidence (set by the resolver).
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
