import { usePending } from '../api/pending.js'
import DecisionCard from '../components/pending/DecisionCard.jsx'

export default function Pending() {
  const { data, isLoading, error } = usePending()

  if (isLoading) return <Loading />
  if (error)     return <ErrorMsg message={error.message} />

  const decisions = data?.decisions ?? data ?? []

  if (!decisions.length) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-600">
        <span className="text-4xl">✓</span>
        <p className="text-sm">No pending decisions — queue is clear.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3 max-w-4xl">
      <p className="text-xs text-gray-500">
        {decisions.length} decision{decisions.length !== 1 ? 's' : ''} pending review — oldest first
      </p>
      {[...decisions]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((d) => (
          <DecisionCard key={d.conflict_id} decision={d} />
        ))}
    </div>
  )
}

function Loading() {
  return <div className="text-sm text-gray-600 py-8 text-center">Loading pending decisions…</div>
}

function ErrorMsg({ message }) {
  return (
    <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
      Failed to load pending decisions: {message}
    </div>
  )
}
