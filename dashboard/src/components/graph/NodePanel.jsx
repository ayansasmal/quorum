import { X } from 'lucide-react'
import ConfidenceBar from '../stats/ConfidenceBar.jsx'
import { entityBadge, fmtDate } from '../../lib/utils.js'

/** Slide-in panel shown when a graph node is clicked. */
export default function NodePanel({ node, onClose }) {
  if (!node) return null
  const d = node.data()

  return (
    <div className="absolute top-0 right-0 h-full w-72 bg-gray-900/95 border-l border-gray-800 overflow-y-auto shadow-2xl z-10">
      <div className="sticky top-0 flex items-center justify-between bg-gray-900 border-b border-gray-800 px-4 py-3">
        <span className="text-xs font-mono text-blue-400 truncate">{d.topic}:{d.key}</span>
        <button onClick={onClose}><X className="h-4 w-4 text-gray-500 hover:text-gray-300" /></button>
      </div>
      <div className="p-4 space-y-3">
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${entityBadge(d.entity_type)}`}>
          {d.entity_type}
        </span>
        <ConfidenceBar value={d.confidence} showLabel />
        {d.summary && <p className="text-sm text-gray-400 leading-relaxed">{d.summary}</p>}
        <div className="text-xs text-gray-600 space-y-1">
          <p>Author: <span className="text-gray-400">{d.author ?? '—'}</span></p>
          <p>Status: <span className="text-gray-400">{d.status}</span></p>
        </div>
      </div>
    </div>
  )
}
