import { useState, useCallback } from 'react'
import { X } from 'lucide-react'

/** Allowed entity type options for the knowledge entry. */
const ENTITY_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']

/** Regex for topic / key / tag slug validation. */
const SLUG_RE = /^[a-z0-9-]+$/

/** Base Tailwind classes shared by all text inputs and textareas. */
const INPUT_BASE =
  'rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-full'

/** Label classes for all form field labels. */
const LABEL_CLASS = 'block text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1'

/** Inline error text classes. */
const ERROR_CLASS = 'text-xs text-red-400 mt-1'

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
  const [confidence, setConfidence] = useState(initialValues.confidence ?? 0.85)
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
   * @returns {boolean} True when all fields are valid.
   */
  const validate = useCallback(() => {
    // Flush tag input before validating so partially-typed tags are captured.
    const pendingTags = tagInput.trim() ? parseTags(tagInput) : []
    const allTags = [...new Set([...tags, ...pendingTags])]

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

    const invalidTags = allTags.filter((t) => !isValidTag(t))
    if (invalidTags.length > 0) {
      errs.tags = `Invalid tags: ${invalidTags.join(', ')}. Only lowercase letters, digits, and hyphens are allowed.`
    } else if (allTags.length > 10) {
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
    return Object.keys(errs).length === 0
  }, [isSupersede, topic, key, content, tags, tagInput, reason])

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

    // Flush tag input before validation.
    const pendingTags = tagInput.trim() ? parseTags(tagInput) : []
    const allTags = [...new Set([...tags, ...pendingTags])].slice(0, 10)
    if (pendingTags.length > 0) {
      setTags(allTags)
      setTagInput('')
    }

    if (!validate()) return

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
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* API-level error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-900/30 border border-red-700 px-4 py-3 text-sm text-red-400"
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
          <p className="text-sm font-mono text-gray-500 dark:text-gray-400 px-3 py-2 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700">
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
          <p className="text-sm font-mono text-gray-500 dark:text-gray-400 px-3 py-2 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700">
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
          maxLength={500}
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
          <div className="flex flex-wrap gap-1.5 mt-2" role="list" aria-label="Selected tags">
            {tags.map((tag) => (
              <span
                key={tag}
                role="listitem"
                className="inline-flex items-center gap-1 rounded-full bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove tag ${tag}`}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-100 focus:outline-none"
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
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="kf-confidence" className={LABEL_CLASS.replace('mb-1', '')}>
            Confidence
          </label>
          <span className="text-xs font-semibold tabular-nums text-blue-500 dark:text-blue-400">
            {confidencePct}
          </span>
        </div>
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
          className="w-full accent-blue-600"
        />
        <div className="flex justify-between text-xs text-gray-400 mt-0.5">
          <span>50%</span>
          <span>100%</span>
        </div>
      </div>

      {/* Reason — supersede mode only */}
      {isSupersede && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="kf-reason" className={LABEL_CLASS.replace('mb-1', '')}>
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
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-4 py-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
