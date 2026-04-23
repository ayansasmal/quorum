import { useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { useReview } from '../../api/pending.js'

/**
 * Approve / reject / request-changes form.
 * Constitutional Rule 4 enforced: author cannot review their own submission.
 */
export default function ReviewForm({ decision, draftAuthor, onClose }) {
  const { user }     = useAuth()
  const review       = useReview()
  const isSelfAuthor = user?.sub && draftAuthor && user.sub === draftAuthor

  const [action, setAction] = useState('approve')
  const [note,   setNote]   = useState('')
  const [error,  setError]  = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (note.trim().length < 10) {
      setError('Note must be at least 10 characters.')
      return
    }
    setError(null)
    try {
      await review.mutateAsync({ conflictId: decision.conflict_id, action, note: note.trim() })
      onClose?.()
    } catch (err) {
      setError(err.message)
    }
  }

  const ACTIONS = [
    { value: 'approve',          label: 'Approve',          color: 'text-green-400' },
    { value: 'reject',           label: 'Reject',           color: 'text-red-400'   },
    { value: 'request_changes',  label: 'Request changes',  color: 'text-amber-400' },
  ]

  if (isSelfAuthor) {
    return (
      <div className="rounded-md bg-gray-800/50 border border-gray-700 px-4 py-3 text-sm text-gray-500">
        You cannot review your own submission.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Action picker */}
      <div className="flex gap-2">
        {ACTIONS.map(({ value, label, color }) => (
          <label
            key={value}
            className={`flex items-center gap-1.5 cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              action === value
                ? `${color} border-current bg-gray-800`
                : 'border-gray-700 text-gray-500 hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="action"
              value={value}
              checked={action === value}
              onChange={() => setAction(value)}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>

      {/* Note */}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Required: reason for this decision (min 10 chars)"
        rows={3}
        className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5">
          Cancel
        </button>
        <button
          type="submit"
          disabled={review.isPending || note.trim().length < 10}
          className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-4 py-1.5 text-xs font-medium text-white transition-colors"
        >
          {review.isPending ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
    </form>
  )
}
