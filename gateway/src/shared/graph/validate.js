/**
 * Shared knowledge write input validator.
 *
 * Called by all four knowledge write routes before any DB operation.
 * Validates fields in a deterministic order and throws on the first violation.
 *
 * @module gateway/src/shared/graph/validate
 */

/** @type {readonly string[]} */
export const VALID_ENTITY_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']

const SLUG_RE = /^[a-z0-9-]+$/

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown when a knowledge write input fails validation.
 * Provides a machine-readable `field` for upstream error handling.
 */
export class ValidationError extends Error {
  /**
   * @param {string} field  - The field that failed validation.
   * @param {string} message - Human-readable description of the violation.
   */
  constructor(field, message) {
    super(`ValidationError[${field}]: ${message}`)
    this.name = 'ValidationError'
    this.field = field
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Throws a ValidationError for the given field.
 * @param {string} field
 * @param {string} message
 * @returns {never}
 */
function fail(field, message) {
  throw new ValidationError(field, message)
}

/**
 * Validates a slug-style field (topic or key).
 * @param {string} fieldName
 * @param {unknown} value
 * @param {number} maxLen
 */
function validateSlug(fieldName, value, maxLen) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(fieldName, `${fieldName} is required and must be a non-empty string`)
  }
  if (value.length > maxLen) {
    fail(fieldName, `${fieldName} must be at most ${maxLen} characters (got ${value.length})`)
  }
  if (!SLUG_RE.test(value)) {
    fail(fieldName, `${fieldName} must match /^[a-z0-9-]+$/ (lowercase letters, digits, hyphens only)`)
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Validates knowledge write input fields.
 *
 * Validation order (fail-fast):
 *   1. topic     — if present in fields
 *   2. key       — if present in fields
 *   3. content   — always required
 *   4. entity_type — always required
 *   5. tags      — if present in fields
 *   6. confidence — if present in fields
 *   7. reason    — required when opts.requireReason is true; validated whenever present
 *
 * @param {object} fields - Input fields from the request body / URL params.
 * @param {string}  [fields.topic]       - Slug-style topic identifier (max 60 chars).
 * @param {string}  [fields.key]         - Slug-style key identifier (max 80 chars).
 * @param {string}  [fields.content]     - Knowledge content (max 500 chars, no < or >).
 * @param {string}  [fields.entity_type] - Must be one of the five canonical entity types.
 * @param {string[]} [fields.tags]       - Optional tags (max 10; each slug-style, max 40 chars).
 * @param {number}  [fields.confidence]  - Float in [0.5, 1.0].
 * @param {string}  [fields.reason]      - Rationale string (10–500 chars, no < or >).
 * @param {object}  [opts]
 * @param {boolean} [opts.requireReason=false] - When true, reason is mandatory.
 * @returns {void}
 * @throws {ValidationError} On the first failing rule.
 */
export function validateKnowledgeInput(fields = {}, opts = {}) {
  // 1. topic
  if ('topic' in fields) {
    validateSlug('topic', fields.topic, 60)
  }

  // 2. key
  if ('key' in fields) {
    validateSlug('key', fields.key, 80)
  }

  // 3. content — always required
  const { content } = fields
  if (typeof content !== 'string' || content.length === 0) {
    fail('content', 'content is required and must be a non-empty string')
  }
  if (content.length > 500) {
    fail('content', `content must be at most 500 characters (got ${content.length})`)
  }
  if (content.includes('<') || content.includes('>')) {
    fail('content', 'content must not contain < or >')
  }

  // 4. entity_type — always required
  const { entity_type } = fields
  if (typeof entity_type !== 'string' || entity_type.length === 0) {
    fail('entity_type', 'entity_type is required')
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    fail(
      'entity_type',
      `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')} (got '${entity_type}')`,
    )
  }

  // 5. tags — optional, validate if present
  if ('tags' in fields) {
    const { tags } = fields
    if (!Array.isArray(tags)) {
      fail('tags', 'tags must be an array')
    }
    if (tags.length > 10) {
      fail('tags', `tags must have at most 10 items (got ${tags.length})`)
    }
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.length === 0) {
        fail('tags', `each tag must be a non-empty string (got ${JSON.stringify(tag)})`)
      }
      if (tag.length > 40) {
        fail('tags', `each tag must be at most 40 characters (got '${tag}' with ${tag.length} chars)`)
      }
      if (!SLUG_RE.test(tag)) {
        fail('tags', `each tag must match /^[a-z0-9-]+$/ (got '${tag}')`)
      }
    }
  }

  // 6. confidence — optional, validate if present
  if ('confidence' in fields) {
    const { confidence } = fields
    if (typeof confidence !== 'number' || confidence < 0.5 || confidence > 1.0) {
      fail('confidence', `confidence must be a number between 0.5 and 1.0 inclusive (got ${confidence})`)
    }
  }

  // 7. reason — required when opts.requireReason, otherwise validated only if present
  const reasonPresent = 'reason' in fields && fields.reason != null
  if (opts.requireReason && !reasonPresent) {
    fail('reason', 'reason is required for this operation (min 10 chars)')
  }
  if (reasonPresent) {
    const { reason } = fields
    if (typeof reason !== 'string' || reason.length === 0) {
      fail('reason', 'reason must be a non-empty string')
    }
    if (reason.length < 10) {
      fail('reason', `reason must be at least 10 characters (got ${reason.length})`)
    }
    if (reason.length > 500) {
      fail('reason', `reason must be at most 500 characters (got ${reason.length})`)
    }
    if (reason.includes('<') || reason.includes('>')) {
      fail('reason', 'reason must not contain < or >')
    }
  }
}
