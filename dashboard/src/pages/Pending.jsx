import { useState } from 'react'
import { usePending, useDrafts, usePromoteDraft, useReviewDeprecationRequest } from '../api/pending.js'
import { useDeviations } from '../api/deviations.js'
import { useAuth } from '../context/AuthContext.jsx'
import DecisionCard from '../components/pending/DecisionCard.jsx'
import ConfirmDialog from '../components/knowledge/ConfirmDialog.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import { entityBadge, fmtDate } from '../lib/utils.js'

export default function Pending() {
  const { data: pendingData, isLoading: pendingLoading, error: pendingError } = usePending()
  const { data: draftsData,  isLoading: draftsLoading,  error: draftsError  } = useDrafts()
  const { data: overdueData } = useDeviations({ status: 'OVERDUE' })
  const promote         = usePromoteDraft()
  const reviewDepr      = useReviewDeprecationRequest()
  const { currentProjectData } = useAuth()
  const isPE        = currentProjectData?.role === 'principal_architect'

  const [promoteTarget,   setPromoteTarget]   = useState(null)
  const [deprecationReview, setDeprecationReview] = useState(null) // { request, action }

  const allPending          = Array.isArray(pendingData) ? pendingData : []
  const decisions           = allPending.filter(r => (r.decision_type ?? 'conflict') === 'conflict')
  const deprecationRequests = allPending.filter(r => r.decision_type === 'deprecation_request')
  const drafts              = draftsData?.drafts ?? []
  const overdueDeviations   = overdueData?.deviations ?? []

  const isEmpty = !decisions.length && !drafts.length && !deprecationRequests.length && !overdueDeviations.length
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

      {/* ── Deprecation requests ───────────────────────────────────── */}
      {deprecationRequests.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Deprecation requests
            </h2>
            <span className="text-xs text-gray-400">
              {deprecationRequests.length} pending
            </span>
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 dark:border-gray-800">
                <tr>
                  {['Domain', 'Key', 'Requestor', 'Reason', 'Version', ...(isPE ? [''] : [])].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
                {deprecationRequests.map((req) => (
                  <tr key={req.request_id} className="hover:bg-gray-100/40 dark:hover:bg-gray-800/40 align-top">
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 font-mono text-xs">{req.topic}</td>
                    <td className="px-4 py-2.5 text-blue-400 font-mono text-xs">{req.key}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{req.requestor}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-300 max-w-xs">
                      <span className="line-clamp-2">{req.reason}</span>
                      {req.stale_warning && (
                        <span data-testid="stale-warning-badge" className="mt-1 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-[10px]">
                          ⚠ {req.stale_warning}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">
                      v{req.current_version ?? '?'}
                    </td>
                    {isPE && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setDeprecationReview({ request: req, action: 'approve' })}
                            className="rounded px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-800"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => setDeprecationReview({ request: req, action: 'reject' })}
                            className="rounded px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isPE && (
            <p className="text-xs text-gray-500">
              These deprecation requests are awaiting review by a principal architect.
            </p>
          )}
        </section>
      )}

      {/* ── Overdue deferrals ─────────────────────────────────────── */}
      {overdueDeviations.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
              ⚠ Overdue deferrals
            </h2>
            <span className="text-xs text-gray-400">
              {overdueDeviations.length} overdue
            </span>
          </div>

          <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-white dark:bg-gray-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-900/10">
                <tr>
                  {['Catalog', 'Topic / Key', 'Description', 'Severity', 'Last seen'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
                {overdueDeviations.map((dev) => (
                  <tr key={dev.deviation_id} className="hover:bg-orange-50/30 dark:hover:bg-orange-900/10">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-400">{dev.catalog_id}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <span className="text-gray-500">{dev.topic}</span>
                      {' / '}
                      <span className="text-blue-400">{dev.key}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-300 max-w-xs">
                      <span className="line-clamp-2">{dev.description}</span>
                    </td>
                    <td className="px-4 py-2.5 min-w-[100px]">
                      <ConfidenceBar value={dev.severity} showLabel />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                      {fmtDate(dev.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-orange-600 dark:text-orange-400">
            These deferrals have passed their deadline. Action them in the{' '}
            <a href="/deviations" className="underline hover:no-underline">Deviations page</a>.
          </p>
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

      {/* ── Deprecation request review dialog ─────────────────────── */}
      {deprecationReview && (
        <ConfirmDialog
          open={Boolean(deprecationReview)}
          title={deprecationReview.action === 'approve' ? 'Approve Deprecation?' : 'Reject Deprecation Request?'}
          body={
            deprecationReview.action === 'approve'
              ? `Approve deprecation of ${deprecationReview.request.topic}:${deprecationReview.request.key}? The entry will be marked DEPRECATED immediately.`
              : `Reject the deprecation request for ${deprecationReview.request.topic}:${deprecationReview.request.key}? The entry will remain ACTIVE.`
          }
          confirmLabel={deprecationReview.action === 'approve' ? 'Approve' : 'Reject'}
          noteLabel="Reason (required)"
          noteRequired={true}
          onConfirm={async (note) => {
            await reviewDepr.mutateAsync({
              requestId: deprecationReview.request.request_id,
              action:    deprecationReview.action,
              note,
            })
            reviewDepr.reset()
            setDeprecationReview(null)
          }}
          onCancel={() => { reviewDepr.reset(); setDeprecationReview(null) }}
          isSubmitting={reviewDepr.isPending}
          error={reviewDepr.error?.message ?? null}
        />
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
