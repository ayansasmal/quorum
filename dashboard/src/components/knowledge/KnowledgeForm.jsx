import { useState, useCallback } from 'react'
import { X } from 'lucide-react'

/** Allowed entity type options for the knowledge entry. */
const ENTITY_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']

/** Regex for topic / key / tag slug validation. */
const SLUG_RE = /^[a-z0-9-]+$/

/** Base Tailwind classes shared by all text inputs and textareas. */
const INPUT_BASE =
  'rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-full transition-colors'

/** Label classes for all form field labels. */
const LABEL_CLASS = 'block text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-2'

/** Read-only field display (locked in supersede mode). */
const LOCKED_FIELD =
  'rounded-lg bg-gray-100 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3.5 py-2.5 text-sm font-mono text-gray-500 dark:text-gray-400 w-full select-all cursor-default'

/** Inline error text classes. */
const ERROR_CLASS = 'text-xs text-red-400 mt-1.5'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated tag string into an array of trimmed, lower-cased tokens.
 * Empty tokens are discarded.
 *
 * @param {string} raw - Raw input value from the tag text input.
 * @returns {string[]} Parsed tag tokens.
 */
function parseTags(raw) {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Validate a single tag against the slug pattern.
 *
 * @param {string} tag - Tag string to validate.
 * @returns {boolean} True if the tag matches `/^[a-z0-9-]+$/`.
 */
function isValidTag(tag) {
  return SLUG_RE.test(tag)
}

// ---------------------------------------------------------------------------
// KnowledgeForm
// ---------------------------------------------------------------------------

/**
 * Form component for creating a new knowledge entry or superseding an existing one.
 *
 * Operates as a fully controlled component — all mutations are delegated to the
 * `onSubmit` callback; this component never calls the API directly.
 *
 * @param {Object}   props
 * @param {'create'|'supersede'} props.mode          - Determines field editability and submit label.
 * @param {Object}   [props.initialValues]            - Pre-fill values when editing.
 * @param {string}   [props.initialValues.topic]
 * @param {string}   [props.initialValues.key]
 * @param {string}   [props.initialValues.content]
 * @param {string}   [props.initialValues.entity_type]
 * @param {string[]} [props.initialValues.tags]
 * @param {number}   [props.initialValues.confidence]
 * @param {function} props.onSubmit                   - Async callback receiving validated field values.
 * @param {function} props.onCancel                   - Called when the user clicks Cancel.
 * @param {boolean}  [props.isSubmitting]             - Disables the submit button while true.
 * @param {string|null} [props.error]                 - API-level error message to display at the top.
 */
export default function KnowledgeForm({
  mode = 'create',
  initialValues = {},
  onSubmit,
  onCancel,
  isSubmitting = false,
  error = null,
}) {
  const isSupersede = mode === 'supersede'

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const [topic, setTopic] = useState(initialValues.topic ?? '')
  const [key, setKey] = useState(initialValues.key ?? '')
  const [content, setContent] = useState(initialValues.content ?? '')
  const [entityType, setEntityType] = useState(initialValues.entity_type ?? 'Decision')
  const [tags, setTags] = useState(Array.isArray(initialValues.tags) ? initialValues.tags : [])
  const [tagInput, setTagInput] = useState('')
  const [confidence, setConfidence] = useState(
    Math.max(0.5, Math.min(1.0, initialValues?.confidence ?? 0.85))
  )
  const [reason, setReason] = useState('')

  /** Per-field validation error messages. */
  const [fieldErrors, setFieldErrors] = useState({})

  // -------------------------------------------------------------------------
  // Tag management
  // -------------------------------------------------------------------------

  /**
   * Commit any pending text in the tag input field into the tag array.
   * Called on blur and before submit.
   */
  const flushTagInput = useCallback(() => {
    if (!tagInput.trim()) return
    const incoming = parseTags(tagInput)
    setTags((prev) => {
      const merged = [...new Set([...prev, ...incoming])]
      return merged.slice(0, 10)
    })
    setTagInput('')
  }, [tagInput])

  /**
   * Remove a tag chip by value.
   *
   * @param {string} tagToRemove - The tag string to remove from the array.
   */
  const removeTag = useCallback((tagToRemove) => {
    setTags((prev) => prev.filter((t) => t !== tagToRemove))
  }, [])

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Run all client-side validation rules and populate `fieldErrors`.
   *
   * @param {string[]} [overrideTags] - Pre-resolved tag array to validate instead of reading
   *   stale `tags` state. Pass the value computed synchronously in `handleSubmit` to avoid
   *   the async `setTags` race condition.
   * @returns {Object} An object containing any validation error messages keyed by field name.
   */
  const validate = useCallback((overrideTags) => {
    const effectiveTags = overrideTags ?? tags

    const errs = {}

    if (!isSupersede) {
      if (!topic) {
        errs.topic = 'Topic is required.'
      } else if (!SLUG_RE.test(topic)) {
        errs.topic = 'Only lowercase letters, digits, and hyphens are allowed.'
      } else if (topic.length > 60) {
        errs.topic = 'Topic must be 60 characters or fewer.'
      }

      if (!key) {
        errs.key = 'Key is required.'
      } else if (!SLUG_RE.test(key)) {
        errs.key = 'Only lowercase letters, digits, and hyphens are allowed.'
      } else if (key.length > 80) {
        errs.key = 'Key must be 80 characters or fewer.'
      }
    }

    if (!content) {
      errs.content = 'Content is required.'
    } else if (/[<>]/.test(content)) {
      errs.content = 'Content must not contain < or > characters.'
    } else if (content.length > 500) {
      errs.content = 'Content must be 500 characters or fewer.'
    }

    const invalidTags = effectiveTags.filter((t) => !isValidTag(t))
    if (invalidTags.length > 0) {
      errs.tags = `Invalid tags: ${invalidTags.join(', ')}. Only lowercase letters, digits, and hyphens are allowed.`
    } else if (effectiveTags.length > 10) {
      errs.tags = 'A maximum of 10 tags is allowed.'
    }

    if (isSupersede) {
      if (!reason) {
        errs.reason = 'Reason is required when superseding an entry.'
      } else if (reason.length < 10) {
        errs.reason = 'Reason must be at least 10 characters.'
      } else if (reason.length > 500) {
        errs.reason = 'Reason must be 500 characters or fewer.'
      }
    }

    setFieldErrors(errs)
    return errs
  }, [isSupersede, topic, key, content, tags, reason])

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  /**
   * Handle form submission: flush tag input, validate, and call `onSubmit` if valid.
   *
   * @param {React.FormEvent<HTMLFormElement>} e - The native form submit event.
   */
  const handleSubmit = async (e) => {
    e.preventDefault()

    // Prevent Enter-key triggered double-submits when already in flight.
    if (isSubmitting) return

    // Compute the final resolved tag list synchronously before any state updates,
    // so validate() receives the correct value rather than stale `tags` state.
    const pendingTags = tagInput.trim()
      ? [...new Set([...tags, ...tagInput.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)])]
      : tags
    const allTags = pendingTags.slice(0, 10)

    if (allTags.length !== tags.length || tagInput.trim()) {
      setTags(allTags)
      setTagInput('')
    }

    const errs = validate(allTags)
    if (Object.keys(errs).length) return

    /** @type {Object} fields - Validated payload passed to the onSubmit callback. */
    const fields = {
      topic: isSupersede ? initialValues.topic : topic,
      key: isSupersede ? initialValues.key : key,
      content,
      entity_type: entityType,
      tags: allTags,
      confidence,
    }

    if (isSupersede) {
      fields.reason = reason
    }

    await onSubmit(fields)
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const contentLen = content.length
  const contentOverLimit = contentLen > 450
  const confidencePct = `${Math.round(confidence * 100)}%`
  const submitLabel = isSupersede ? 'Save Changes' : 'Add Entry'

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {/* API-level error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {/* Topic */}
      <div>
        <label htmlFor="kf-topic" className={LABEL_CLASS}>
          Topic
        </label>
        {isSupersede ? (
          <p id="kf-topic" className={LOCKED_FIELD}>
            {initialValues.topic}
          </p>
        ) : (
          <input
            id="kf-topic"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={60}
            placeholder="e.g. auth"
            aria-describedby={fieldErrors.topic ? 'kf-topic-error' : undefined}
            aria-invalid={!!fieldErrors.topic}
            className={INPUT_BASE}
          />
        )}
        {fieldErrors.topic && (
          <p id="kf-topic-error" className={ERROR_CLASS}>
            {fieldErrors.topic}
          </p>
        )}
      </div>

      {/* Key */}
      <div>
        <label htmlFor="kf-key" className={LABEL_CLASS}>
          Key
        </label>
        {isSupersede ? (
          <p id="kf-key" className={LOCKED_FIELD}>
            {initialValues.key}
          </p>
        ) : (
          <input
            id="kf-key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            maxLength={80}
            placeholder="e.g. token-strategy"
            aria-describedby={fieldErrors.key ? 'kf-key-error' : undefined}
            aria-invalid={!!fieldErrors.key}
            className={INPUT_BASE}
          />
        )}
        {fieldErrors.key && (
          <p id="kf-key-error" className={ERROR_CLASS}>
            {fieldErrors.key}
          </p>
        )}
      </div>

      {/* Content */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="kf-content" className={LABEL_CLASS.replace('mb-1', '')}>
            Content
          </label>
          <span
            className={`text-xs tabular-nums ${contentOverLimit ? 'text-red-400' : 'text-gray-400 dark:text-gray-500'}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {contentLen} / 500
          </span>
        </div>
        <textarea
          id="kf-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          placeholder="Describe this knowledge entry…"
          aria-describedby={fieldErrors.content ? 'kf-content-error' : undefined}
          aria-invalid={!!fieldErrors.content}
          className={`${INPUT_BASE} resize-y`}
        />
        {fieldErrors.content && (
          <p id="kf-content-error" className={ERROR_CLASS}>
            {fieldErrors.content}
          </p>
        )}
      </div>

      {/* Entity type */}
      <div>
        <label htmlFor="kf-entity-type" className={LABEL_CLASS}>
          Entity Type
        </label>
        <select
          id="kf-entity-type"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className={INPUT_BASE}
        >
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Tags */}
      <div>
        <label htmlFor="kf-tags" className={LABEL_CLASS}>
          Tags
          <span className="normal-case ml-1 text-gray-400">(comma-separated, max 10)</span>
        </label>
        <input
          id="kf-tags"
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onBlur={flushTagInput}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              flushTagInput()
            }
          }}
          placeholder="e.g. auth, lambda"
          aria-describedby={fieldErrors.tags ? 'kf-tags-error' : undefined}
          aria-invalid={!!fieldErrors.tags}
          className={INPUT_BASE}
          disabled={tags.length >= 10}
        />
        {/* Tag chips */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2.5" role="list" aria-label="Selected tags">
            {tags.map((tag) => (
              <span
                key={tag}
                role="listitem"
                className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 dark:bg-blue-900/25 border border-blue-200 dark:border-blue-800 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove tag ${tag}`}
                  className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200 focus:outline-none rounded-full"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {fieldErrors.tags && (
          <p id="kf-tags-error" className={ERROR_CLASS}>
            {fieldErrors.tags}
          </p>
        )}
      </div>

      {/* Confidence */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label htmlFor="kf-confidence" className={LABEL_CLASS.replace('mb-2', 'mb-0')}>
            Confidence
          </label>
          <span className="text-sm font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {confidencePct}
          </span>
        </div>
        <div className="px-0.5">
          <input
            id="kf-confidence"
            type="range"
            min={0.5}
            max={1.0}
            step={0.05}
            value={confidence}
            onChange={(e) => setConfidence(parseFloat(e.target.value))}
            aria-valuemin={0.5}
            aria-valuemax={1.0}
            aria-valuenow={confidence}
            aria-valuetext={confidencePct}
            className="w-full accent-blue-600 cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
            <span>50%</span>
            <span>100%</span>
          </div>
        </div>
      </div>

      {/* Reason — supersede mode only */}
      {isSupersede && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="kf-reason" className={LABEL_CLASS.replace('mb-2', 'mb-0')}>
              Reason for superseding
            </label>
            <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500">
              {reason.length} / 500
            </span>
          </div>
          <textarea
            id="kf-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Explain why this entry is being superseded (min 10 chars)…"
            aria-describedby={fieldErrors.reason ? 'kf-reason-error' : undefined}
            aria-invalid={!!fieldErrors.reason}
            className={`${INPUT_BASE} resize-y`}
          />
          {fieldErrors.reason && (
            <p id="kf-reason-error" className={ERROR_CLASS}>
              {fieldErrors.reason}
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-100 dark:border-gray-800">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="text-sm font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-transparent border border-gray-300 dark:border-gray-600 px-4 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2 rounded-lg disabled:opacity-50 transition-colors shadow-sm"
        >
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
