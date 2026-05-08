/**
 * Confidence lifecycle — pure functions, no side effects.
 *
 * Confidence is a 0–1 score on each knowledge node that evolves:
 *   - Starts at author-provided value (default 0.7)
 *   - Increases when recalled frequently (+0.01 per recall)
 *   - Decreases as the node ages without access (-0.005/week)
 *   - Drops when a conflict is raised against it (-0.1)
 *   - Rises when a conflict is resolved in its favour (+0.1)
 */

const MIN = 0.0
const MAX = 1.0

const clamp = (v) => Math.min(MAX, Math.max(MIN, v))

/**
 * Initial confidence for a new knowledge node.
 * @param {number | undefined | null} authorProvided
 * @returns {number}
 */
export function initialConfidence(authorProvided) {
  if (authorProvided == null || typeof authorProvided !== 'number') return 0.7
  return clamp(authorProvided)
}

/**
 * Confidence bump applied each time a node is recalled.
 * @param {number} current
 * @returns {number}
 */
export function onRecall(current) {
  return clamp(current + 0.01)
}

/**
 * Confidence decay applied for each week the node has not been accessed.
 * @param {number} current
 * @param {number} weeksSinceAccess
 * @returns {number}
 */
export function onAgeDecay(current, weeksSinceAccess) {
  return clamp(current - 0.005 * weeksSinceAccess)
}

/**
 * Confidence penalty when a conflict is raised against this node.
 * @param {number} current
 * @returns {number}
 */
export function onConflictRaised(current) {
  return clamp(current - 0.1)
}

/**
 * Confidence bonus when a conflict is resolved in this node's favour.
 * @param {number} current
 * @returns {number}
 */
export function onConflictResolvedFor(current) {
  return clamp(current + 0.1)
}
