import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Reusable confirmation dialog for knowledge actions
 *
 * @param {Object} props
 * @param {boolean} props.open - Whether the dialog is visible
 * @param {string} props.title - Dialog title
 * @param {string} props.body - Dialog body text
 * @param {string} props.confirmLabel - Confirm button label
 * @param {boolean} [props.destructive=false] - If true, confirm button is red instead of blue
 * @param {string} [props.noteLabel] - Label for the note/reason textarea
 * @param {boolean} [props.noteRequired=false] - If true, show a required note textarea (min 10 chars)
 * @param {Function} props.onConfirm - Called with note value (empty string if noteRequired=false)
 * @param {Function} props.onCancel - Called when user cancels the dialog
 * @param {boolean} [props.isSubmitting=false] - If true, disable confirm button and show loading state
 * @param {string|null} [props.error=null] - Error string to display in red banner
 * @returns {JSX.Element|null}
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  destructive = false,
  noteLabel,
  noteRequired = false,
  onConfirm,
  onCancel,
  isSubmitting = false,
  error = null,
}) {
  const [note, setNote] = useState('')
  const dialogRef = useRef(null)

  /**
   * Keep a stable ref to onCancel so the ESC keydown handler never closes over a
   * stale copy of the callback between renders.
   */
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])

  // Reset note when dialog opens
  useEffect(() => {
    if (open) {
      setNote('')
    }
  }, [open])

  // Handle ESC key — depends only on `open`; uses ref to avoid stale-closure risk.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onCancelRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  // Move focus to the dialog container when it opens for proper keyboard/a11y flow.
  useEffect(() => {
    if (open && dialogRef.current) {
      dialogRef.current.focus()
    }
  }, [open])

  // Confirm button is disabled if:
  // - isSubmitting
  // - noteRequired && note.length < 10
  const isConfirmDisabled = isSubmitting || (noteRequired && note.length < 10)

  const handleBackdropClick = useCallback(() => {
    if (isSubmitting) return
    onCancel()
  }, [isSubmitting, onCancel])

  const handleConfirm = () => {
    if (!isConfirmDisabled) {
      onConfirm(noteRequired ? note : '')
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl w-full max-w-md p-6 space-y-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {title}
        </h2>

        {/* Body */}
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {body}
        </p>

        {/* Error Banner */}
        {error && (
          <div
            role="alert"
            className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* Note Field */}
        {noteRequired && (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {noteLabel || 'Note'} <span className="text-red-600">*</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`Enter at least 10 characters…`}
              className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              disabled={isSubmitting}
            />
            {noteRequired && (
              <p className="text-xs">
                <span className={note.length >= 10 ? 'text-gray-400' : 'text-amber-400'}>
                  {note.length} / 10 chars minimum
                </span>
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className={`px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isSubmitting ? 'Loading…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
