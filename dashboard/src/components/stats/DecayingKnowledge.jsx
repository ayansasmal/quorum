import { useState } from 'react'
import { useKnowledge } from '../../api/knowledge.js'
import ConfidenceBar from './ConfidenceBar.jsx'
import BumpButton from './BumpButton.jsx'
import { fmtDate } from '../../lib/utils.js'

const FILTERS = [
  { label: 'All',       domain: undefined, maxConf: 1.0  },
  { label: 'Decaying',  domain: undefined, maxConf: 0.5  },
  { label: 'At Risk',   domain: undefined, maxConf: 0.3  },
]

/**
 * Sub-view of the Stats page. Shows knowledge sorted by confidence ascending
 * so engineers can see what's at risk of decaying below the useful floor.
 */
export default function DecayingKnowledge() {
  const [filterIdx, setFilterIdx] = useState(0)
  const [domain,    setDomain]    = useState('')

  const { data, isLoading } = useKnowledge({ domain: domain || undefined, limit: 50 })

  const maxConf = FILTERS[filterIdx].maxConf

  const rows = [...(data?.items ?? [])]
    .filter((r) => r.confidence <= maxConf)
    .sort((a, b) => a.confidence - b.confidence)

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
          {FILTERS.map(({ label }, i) => (
            <button
              key={label}
              onClick={() => setFilterIdx(i)}
              className={`px-3 py-1.5 transition-colors ${
                filterIdx === i ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-xs text-gray-300"
        >
          <option value="">All domains</option>
          {['auth', 'api', 'db', 'infra', 'testing'].map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {/* Note about GAP-04 dependency */}
      {filterIdx > 0 && (
        <p className="text-[11px] text-gray-600 italic">
          Decay data only appears after the confidence decay CronJob (GAP-04) has been running for ≥1 week.
        </p>
      )}

      {/* Table */}
      {isLoading ? (
        <p className="text-sm text-gray-600 text-center py-4">Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-gray-600 text-center py-4">
          {filterIdx === 0 ? 'No knowledge nodes.' : 'No nodes below this confidence threshold.'}
        </p>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-800 bg-gray-900/50">
              <tr>
                {['Domain:Key', 'Type', 'Confidence', 'Last accessed', 'Author', ''].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50 bg-gray-900">
              {rows.map((row, i) => (
                <tr key={i} className="hover:bg-gray-800/30">
                  <td className="px-3 py-2 font-mono text-blue-400">
                    {row.topic}:{row.key}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{row.entity_type}</td>
                  <td className="px-3 py-2 min-w-[120px]">
                    <ConfidenceBar value={row.confidence} showLabel />
                  </td>
                  <td className="px-3 py-2 text-gray-600">{fmtDate(row.last_accessed_at ?? row.updated_at)}</td>
                  <td className="px-3 py-2 text-gray-500">{row.author}</td>
                  <td className="px-3 py-2 text-right">
                    <BumpButton topic={row.topic} key_={row.key} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
