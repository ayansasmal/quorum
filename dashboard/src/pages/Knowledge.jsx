import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, MoreHorizontal } from 'lucide-react'
import { useKnowledge, useSearch, useKnowledgeWrite } from '../api/knowledge.js'
import { useStats } from '../api/stats.js'
import { useAuth } from '../context/AuthContext.jsx'
import KnowledgeDetail from '../components/knowledge/KnowledgeDetail.jsx'
import KnowledgeForm from '../components/knowledge/KnowledgeForm.jsx'
import ConfirmDialog from '../components/knowledge/ConfirmDialog.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import { entityBadge, fmtDate } from '../lib/utils.js'

const ENTITY_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']

export default function Knowledge() {
  const [domain,        setDomain]        = useState('')
  const [entityType,    setEntityType]    = useState('')
  const [page,          setPage]          = useState(1)
  const [query,         setQuery]         = useState('')
  const [selected,      setSelected]      = useState(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editTarget,    setEditTarget]    = useState(null)
  const [promoteTarget, setPromoteTarget] = useState(null)
  const [openMenu,      setOpenMenu]      = useState(null)
  const [writeSuccess,  setWriteSuccess]  = useState(null)
  const successTimerRef = useRef(null)

  const { currentProjectData } = useAuth()
  const isPE = currentProjectData?.role === 'principal_architect'

  const write = useKnowledgeWrite(() => {
    clearTimeout(successTimerRef.current)
    setWriteSuccess('Saved.')
    successTimerRef.current = setTimeout(() => setWriteSuccess(null), 3000)
  })

  useEffect(() => () => clearTimeout(successTimerRef.current), [])

  useEffect(() => {
    if (!openMenu) return
    const close = () => setOpenMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenu])

  const isSearching = query.trim().length >= 2

  const { data: statsData } = useStats()
  const domainOptions = (statsData?.domains ?? []).map((d) => d.domain)

  const browseResult = useKnowledge({ domain, entity_type: entityType, page, limit: 20 })
  const searchResult = useSearch(isSearching ? query : '', domain)

  const { data, isLoading, error } = isSearching ? searchResult : browseResult

  const items = isSearching
    ? (data?.results ?? [])
    : (data?.items   ?? [])

  return (
    <div className="space-y-4 max-w-5xl">

      {/* Filters + search bar */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by tag, key, or topic…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1) }}
            className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={domain}
          onChange={(e) => { setDomain(e.target.value); setPage(1) }}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <option value="">All domains</option>
          {domainOptions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          value={entityType}
          onChange={(e) => { setEntityType(e.target.value); setPage(1) }}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {isPE && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
          >
            + Add entry
          </button>
        )}
      </div>

      {/* Success banner */}
      {writeSuccess && (
        <p className="text-sm text-green-600 dark:text-green-400">{writeSuccess}</p>
      )}

      {/* Results */}
      {isLoading ? (
        <p className="text-sm text-gray-600 py-8 text-center">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-4">{error.message}</p>
      ) : !items.length ? (
        <p className="text-sm text-gray-600 py-8 text-center">No knowledge found.</p>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 dark:border-gray-800">
              <tr>
                {[...['Domain', 'Key', 'Type', 'Confidence', 'Author', 'Updated'], ...(isPE ? [''] : [])].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
              {items.map((row) => (
                <tr
                  key={`${row.topic}:${row.key}`}
                  onClick={() => setSelected(row)}
                  className="hover:bg-gray-100/40 dark:hover:bg-gray-800/40 cursor-pointer"
                >
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
                  <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(row.updated_at)}</td>
                  {isPE && (
                    <td className="px-2 py-2.5 w-8" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (openMenu?.row === row) {
                            setOpenMenu(null)
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setOpenMenu({ row, top: rect.bottom + 4, right: window.innerWidth - rect.right })
                          }
                        }}
                        className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        aria-label="Row actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination (browse mode only) */}
      {!isSearching && data?.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{data.total} total</span>
          <div className="flex gap-2">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-2 py-1">Page {page} of {data.pages}</span>
            <button
              disabled={page >= data.pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Row action menu (portal — avoids overflow-hidden clip) */}
      {openMenu && createPortal(
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1"
          style={{ top: openMenu.top, right: openMenu.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {(openMenu.row.status ?? 'ACTIVE') === 'DRAFT' ? (
            <button
              onClick={() => { setOpenMenu(null); setPromoteTarget(openMenu.row) }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Promote to Active
            </button>
          ) : (
            <button
              onClick={() => { setOpenMenu(null); setEditTarget(openMenu.row) }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Edit
            </button>
          )}
        </div>,
        document.body
      )}

      {/* Detail panel */}
      {selected && <KnowledgeDetail row={selected} onClose={() => setSelected(null)} />}

      {/* Create form modal */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl">
            <KnowledgeForm
              mode="create"
              onSubmit={async (fields) => {
                await write.create.mutateAsync(fields)
                write.create.reset()
                setShowCreateForm(false)
              }}
              onCancel={() => { write.create.reset(); setShowCreateForm(false) }}
              isSubmitting={write.create.isPending}
              error={write.create.error?.message ?? null}
            />
          </div>
        </div>
      )}

      {/* Supersede (edit) form modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl">
            <KnowledgeForm
              mode="supersede"
              initialValues={{
                topic:       editTarget.topic,
                key:         editTarget.key,
                content:     editTarget.summary ?? editTarget.content ?? '',
                entity_type: editTarget.entity_type,
                tags:        editTarget.tags ?? [],
                confidence:  editTarget.confidence ?? 0.85,
              }}
              onSubmit={async (fields) => {
                await write.supersede.mutateAsync({
                  topic: editTarget.topic,
                  key:   editTarget.key,
                  ...fields,
                })
                write.supersede.reset()
                setEditTarget(null)
              }}
              onCancel={() => { write.supersede.reset(); setEditTarget(null) }}
              isSubmitting={write.supersede.isPending}
              error={write.supersede.error?.message ?? null}
            />
          </div>
        </div>
      )}

      {/* Promote confirm dialog */}
      {promoteTarget && (
        <ConfirmDialog
          open={Boolean(promoteTarget)}
          title="Promote to Active?"
          body={`Promote ${promoteTarget.topic}:${promoteTarget.key} to Active? It will replace any existing Active version.`}
          confirmLabel="Promote"
          noteLabel="Reason for promoting"
          noteRequired={true}
          onConfirm={async (note) => {
            await write.promote.mutateAsync({
              topic: promoteTarget.topic,
              key:   promoteTarget.key,
              note,
            })
            write.promote.reset()
            setPromoteTarget(null)
          }}
          onCancel={() => { write.promote.reset(); setPromoteTarget(null) }}
          isSubmitting={write.promote.isPending}
          error={write.promote.error?.message ?? null}
        />
      )}
    </div>
  )
}
