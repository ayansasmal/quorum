import { useState } from 'react'
import { usePending, useDrafts, usePromoteDraft } from '../api/pending.js'
import { useAuth } from '../context/AuthContext.jsx'
import DecisionCard from '../components/pending/DecisionCard.jsx'
import ConfirmDialog from '../components/knowledge/ConfirmDialog.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import { entityBadge, fmtDate } from '../lib/utils.js'

export default function Pending() {
  const { data: pendingData, isLoading: pendingLoading, error: pendingError } = usePending()
  const { data: draftsData,  isLoading: draftsLoading,  error: draftsError  } = useDrafts()
  const promote     = usePromoteDraft()
  const { currentProjectData } = useAuth()
  const isPE        = currentProjectData?.role === 'principal_architect'

  const [promoteTarget, setPromoteTarget] = useState(null)

  const decisions = pendingData?.decisions ?? pendingData ?? []
  const drafts    = draftsData?.drafts ?? []

  const isEmpty = !decisions.length && !drafts.length
  const isLoading = pendingLoading || draftsLoading
  const error     = pendingError || draftsError

  if (isLoading) return <Loading />
  if (error)     return <ErrorMsg message={error.message} />

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-600">
        <span className="text-4xl">✓</span>
        <p className="text-sm">No pending decisions — queue is clear.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">

      {/* ── DRAFT entries awaiting PE review ───────────────────────── */}
      {drafts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Draft entries — awaiting review
            </h2>
            <span className="text-xs text-gray-400">{drafts.length} pending</span>
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 dark:border-gray-800">
                <tr>
                  {['Domain', 'Key', 'Type', 'Confidence', 'Author', 'Created', ...(isPE ? [''] : [])].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
                {drafts.map((row) => (
                  <tr key={`${row.topic}:${row.key}`} className="hover:bg-gray-100/40 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 font-mono text-xs">{row.topic}</td>
                    <td className="px-4 py-2.5 text-blue-400 font-mono text-xs">{row.key}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${entityBadge(row.entity_type)}`}>
                        {row.entity_type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 min-w-[120px]">
                      <ConfidenceBar value={row.confidence} showLabel />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{row.author}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(row.created_at)}</td>
                    {isPE && (
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => setPromoteTarget(row)}
                          className="rounded px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-800"
                        >
                          Promote
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isPE && (
            <p className="text-xs text-gray-500">
              These entries are awaiting review by a principal architect.
            </p>
          )}
        </section>
      )}

      {/* ── Conflict decisions ─────────────────────────────────────── */}
      {decisions.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Conflict decisions
            </h2>
            <span className="text-xs text-gray-400">
              {decisions.length} decision{decisions.length !== 1 ? 's' : ''} — oldest first
            </span>
          </div>
          {[...decisions]
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .map((d) => (
              <DecisionCard key={d.conflict_id} decision={d} />
            ))}
        </section>
      )}

      {/* ── Promote confirm dialog ─────────────────────────────────── */}
      {promoteTarget && (
        <ConfirmDialog
          open={Boolean(promoteTarget)}
          title="Promote to Active?"
          body={`Promote ${promoteTarget.topic}:${promoteTarget.key} to Active? It will replace any existing Active version.`}
          confirmLabel="Promote"
          noteLabel="Reason for promoting"
          noteRequired={true}
          onConfirm={async (note) => {
            await promote.mutateAsync({ topic: promoteTarget.topic, key: promoteTarget.key, note })
            promote.reset()
            setPromoteTarget(null)
          }}
          onCancel={() => { promote.reset(); setPromoteTarget(null) }}
          isSubmitting={promote.isPending}
          error={promote.error?.message ?? null}
        />
      )}
    </div>
  )
}

function Loading() {
  return <div className="text-sm text-gray-600 py-8 text-center">Loading pending items…</div>
}

function ErrorMsg({ message }) {
  return (
    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
      Failed to load pending items: {message}
    </div>
  )
}
