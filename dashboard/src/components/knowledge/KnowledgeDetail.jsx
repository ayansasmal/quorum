import { X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../api/client.js'
import ConfidenceBar from '../stats/ConfidenceBar.jsx'
import VersionTimeline from './VersionTimeline.jsx'
import { entityBadge, fmtDate } from '../../lib/utils.js'

export default function KnowledgeDetail({ row, onClose }) {
  const { data: history } = useQuery({
    queryKey: ['history', row.topic, row.key],
    queryFn:  () => apiFetch(`/pg/versions/${encodeURIComponent(row.topic)}/${encodeURIComponent(row.key)}`),
    enabled:  !!row,
  })

  const versions = history?.versions ?? []

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative w-full max-w-xl h-full bg-gray-900 border-l border-gray-800 overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between bg-gray-900 border-b border-gray-800 px-5 py-4">
          <div>
            <p className="text-xs text-gray-500">{row.topic}</p>
            <h2 className="font-mono text-sm font-bold text-white">{row.key}</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Meta */}
        <div className="px-5 py-4 space-y-3 border-b border-gray-800">
          <div className="flex flex-wrap gap-2">
            <Badge className={entityBadge(row.entity_type)}>{row.entity_type}</Badge>
            {(row.tags ?? []).map((t) => (
              <Badge key={t} className="text-gray-400 bg-gray-800 border-gray-700">{t}</Badge>
            ))}
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>v{row.version}</span>
            <span>by <span className="text-gray-300">{row.author}</span></span>
            <span>{fmtDate(row.updated_at)}</span>
          </div>
          <ConfidenceBar value={row.confidence} showLabel />
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
