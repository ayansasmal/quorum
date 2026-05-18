import { useState } from 'react'
import { X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../api/client.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { useKnowledgeWrite } from '../../api/knowledge.js'
import KnowledgeForm from './KnowledgeForm.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ConfidenceBar from '../stats/ConfidenceBar.jsx'
import VersionTimeline from './VersionTimeline.jsx'
import { entityBadge, fmtDate } from '../../lib/utils.js'

export default function KnowledgeDetail({ row, onClose }) {
  const [showEdit,    setShowEdit]    = useState(false)
  const [showPromote, setShowPromote] = useState(false)

  const { currentProjectData } = useAuth()
  const isPE = currentProjectData?.role === 'principal_architect'
  const write = useKnowledgeWrite()

  const { data: detail, isLoading } = useQuery({
    queryKey: ['knowledge-detail', row.topic, row.key],
    queryFn:  () => apiFetch(`/api/knowledge/${encodeURIComponent(row.topic)}/${encodeURIComponent(row.key)}`),
    enabled:  !!row,
    staleTime: 60_000,
  })

  const { data: history } = useQuery({
    queryKey: ['history', row.topic, row.key],
    queryFn:  () => apiFetch(`/pg/versions/${encodeURIComponent(row.topic)}/${encodeURIComponent(row.key)}/history`),
    enabled:  !!row,
  })

  const versions = Array.isArray(history) ? history : []
  const tags = detail?.tags ?? row.tags ?? []
  // Use detail.content (from PG summary + Graphiti fallback), then fall back to
  // the most recent version's summary from the already-fetched history, so entries
  // with content stored only in history records still render without a second fetch.
  const content = detail?.content || versions[0]?.summary || null
  const status = detail?.status ?? row.status ?? 'ACTIVE'

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative w-full max-w-xl h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-5 py-4">
          <div>
            <p className="text-xs text-gray-500">{row.topic}</p>
            <h2 className="font-mono text-sm font-bold text-gray-900 dark:text-white">{row.key}</h2>
          </div>
          <div className="flex items-center gap-2">
            {isPE && status === 'DRAFT' && (
              <button
                onClick={() => setShowPromote(true)}
                className="rounded-md bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 text-xs font-medium"
              >
                Promote
              </button>
            )}
            {isPE && status === 'ACTIVE' && (
              <button
                onClick={() => setShowEdit(true)}
                className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium"
              >
                Edit
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Meta */}
        <div className="px-5 py-4 space-y-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex flex-wrap gap-2">
            <Badge className={entityBadge(row.entity_type)}>{row.entity_type}</Badge>
            {tags.map((t) => (
              <Badge key={t} className="text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700">{t}</Badge>
            ))}
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>v{row.version}</span>
            <span>by <span className="text-gray-600 dark:text-gray-300">{row.author}</span></span>
            <span>{fmtDate(row.updated_at)}</span>
          </div>
          <ConfidenceBar value={row.confidence} showLabel />
        </div>

        {/* Content */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">Knowledge</h3>
          {isLoading ? (
            <p className="text-xs text-gray-400 animate-pulse">Loading…</p>
          ) : content ? (
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{content}</p>
          ) : (
            <p className="text-xs text-gray-400 italic">
              Content not stored — this entry predates the durable summary store.
              Re-enter it via <code className="font-mono">remember()</code> in the MCP to restore it.
            </p>
          )}
        </div>

        {/* Version history */}
        <div className="px-5 py-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-4">Version history</h3>
          <VersionTimeline versions={versions} />
        </div>

        {/* Edit (supersede) modal */}
        {showEdit && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl">
              <KnowledgeForm
                mode="supersede"
                initialValues={{
                  topic:       row.topic,
                  key:         row.key,
                  content:     content ?? '',
                  entity_type: row.entity_type,
                  tags:        tags,
                  confidence:  row.confidence ?? 0.85,
                }}
                onSubmit={async (fields) => {
                  await write.supersede.mutateAsync({ topic: row.topic, key: row.key, ...fields })
                  write.supersede.reset()
                  setShowEdit(false)
                }}
                onCancel={() => { write.supersede.reset(); setShowEdit(false) }}
                isSubmitting={write.supersede.isPending}
                error={write.supersede.error?.message ?? null}
              />
            </div>
          </div>
        )}

        {/* Promote confirm dialog */}
        {showPromote && (
          <ConfirmDialog
            open={showPromote}
            title="Promote to Active?"
            body={`Promote ${row.topic}:${row.key} to Active? It will replace any existing Active version.`}
            confirmLabel="Promote"
            noteLabel="Reason for promoting"
            noteRequired={true}
            onConfirm={async (note) => {
              await write.promote.mutateAsync({ topic: row.topic, key: row.key, note })
              write.promote.reset()
              setShowPromote(false)
            }}
            onCancel={() => { write.promote.reset(); setShowPromote(false) }}
            isSubmitting={write.promote.isPending}
            error={write.promote.error?.message ?? null}
          />
        )}
      </div>
    </div>
  )
}

/**
 * @param {object} props
 * @param {string} props.className - Tailwind class string for color/style variants
 * @param {React.ReactNode} props.children - Badge label content
 */
function Badge({ className, children }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  )
}
