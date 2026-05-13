import { X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../api/client.js'
import ConfidenceBar from '../stats/ConfidenceBar.jsx'
import VersionTimeline from './VersionTimeline.jsx'
import { entityBadge, fmtDate } from '../../lib/utils.js'

export default function KnowledgeDetail({ row, onClose }) {
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
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <X className="h-5 w-5" />
          </button>
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
      </div>
    </div>
  )
}

function Badge({ className, children }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  )
}
