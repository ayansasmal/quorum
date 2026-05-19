import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

const MAX_CHIPS_SHOWN = 5

/**
 * Focused confirmation dialog for deprecating one or many knowledge entries.
 * Used by all three deprecate surfaces: per-row icon, bulk action bar, edit modal link.
 *
 * @param {Object} props
 * @param {Array<{topic: string, key: string}>} props.entries - Entries to deprecate (1 or many)
 * @param {function(string): Promise<void>} props.onConfirm - Called with validated reason (≥10 chars)
 * @param {function(): void} props.onCancel
 * @param {boolean} [props.isSubmitting=false]
 * @param {string|null} [props.error=null]
 */
export default function DeprecateDialog({
  entries,
  onConfirm,
  onCancel,
  isSubmitting = false,
  error = null,
}) {
  const [reason, setReason] = useState('')
  const dialogRef  = useRef(null)
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])

  useEffect(() => {
    setReason('')
  }, [entries])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancelRef.current() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const isBulk     = entries.length > 1
  const title      = isBulk ? `Deprecate ${entries.length} entries` : 'Deprecate entry'
  const shownChips = entries.slice(0, MAX_CHIPS_SHOWN)
  const overflow   = entries.length - MAX_CHIPS_SHOWN
  const canConfirm = !isSubmitting && reason.trim().length >= 10

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={() => { if (!isSubmitting) onCancel() }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl w-full max-w-md p-6 space-y-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-red-500 shrink-0" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
        </div>

        {/* Entry display */}
        {isBulk ? (
          <div className="flex flex-wrap gap-1.5">
            {shownChips.map(({ topic, key }) => (
              <span
                key={`${topic}:${key}`}
                className="font-mono text-[11px] bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-0.5 text-gray-700 dark:text-gray-300"
              >
                {topic}:{key}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-[11px] text-gray-500 self-center">+{overflow} more</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400 font-mono">
            {entries[0]?.topic}:{entries[0]?.key}
          </p>
        )}

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* Reason */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Reason <span className="text-red-600">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Enter at least 10 characters…"
            className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            rows={3}
            disabled={isSubmitting}
          />
          <p className="text-xs">
            <span className={reason.trim().length >= 10 ? 'text-gray-400' : 'text-amber-400'}>
              {reason.trim().length} / 10 chars minimum
            </span>
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => canConfirm && onConfirm(reason.trim())}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Deprecating…' : 'Deprecate'}
          </button>
        </div>
      </div>
    </div>
  )
}
