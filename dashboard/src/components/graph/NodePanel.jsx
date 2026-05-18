import { X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../api/client.js'
import ConfidenceBar from '../stats/ConfidenceBar.jsx'
import { entityBadge } from '../../lib/utils.js'

/** Slide-in panel shown when a graph node is clicked. */
export default function NodePanel({ node, onClose }) {
  if (!node) return null
  const d = node.data()

  // Hub nodes have no topic/key — show nothing
  if (d.node_type === 'hub') return null

  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-detail', d.topic, d.key],
    queryFn:  () => apiFetch(`/api/knowledge/${encodeURIComponent(d.topic)}/${encodeURIComponent(d.key)}`),
    enabled:  !!(d.topic && d.key),
    staleTime: 60_000,
  })

  return (
    <div className="absolute top-0 right-0 h-full w-80 bg-white/95 dark:bg-gray-900/95 border-l border-gray-200 dark:border-gray-800 overflow-y-auto shadow-2xl z-10">
      <div className="sticky top-0 flex items-center justify-between bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <span className="text-xs font-mono text-blue-400 truncate">{d.topic}:{d.key}</span>
        <button onClick={onClose}><X className="h-4 w-4 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" /></button>
      </div>
      <div className="p-4 space-y-3">
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${entityBadge(d.entity_type)}`}>
          {d.entity_type}
        </span>
        <ConfidenceBar value={d.confidence} showLabel />

        {isLoading ? (
          <p className="text-xs text-gray-500 animate-pulse">Loading content…</p>
        ) : data?.content ? (
          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{data.content}</p>
        ) : (
          <p className="text-xs text-gray-400 italic">No content available</p>
        )}

        {(data?.tags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.tags.map((t) => (
              <span key={t} className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 rounded px-1.5 py-0.5">{t}</span>
            ))}
          </div>
        )}

        <div className="text-xs text-gray-500 space-y-1 pt-1 border-t border-gray-100 dark:border-gray-800">
          <p>Author: <span className="text-gray-600 dark:text-gray-400">{data?.author ?? d.author ?? '—'}</span></p>
          <p>Version: <span className="text-gray-600 dark:text-gray-400">v{data?.version ?? '—'}</span></p>
          <p>Status: <span className="text-gray-600 dark:text-gray-400">{d.status}</span></p>
        </div>
      </div>
    </div>
  )
}
