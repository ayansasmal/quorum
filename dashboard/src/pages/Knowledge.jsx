import { useState } from 'react'
import { Search } from 'lucide-react'
import { useKnowledge, useSearch } from '../api/knowledge.js'
import KnowledgeDetail from '../components/knowledge/KnowledgeDetail.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import { entityBadge, fmtDate } from '../lib/utils.js'

const ENTITY_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']

export default function Knowledge() {
  const [domain,      setDomain]      = useState('')
  const [entityType,  setEntityType]  = useState('')
  const [page,        setPage]        = useState(1)
  const [query,       setQuery]       = useState('')
  const [selected,    setSelected]    = useState(null)

  const isSearching = query.trim().length >= 2

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
            placeholder="Semantic search…"
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
          {['auth', 'api', 'db', 'infra', 'testing'].map((d) => (
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
      </div>

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
                {['Domain', 'Key', 'Type', 'Confidence', 'Author', 'Updated'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
              {items.map((row, i) => (
                <tr
                  key={i}
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

      {/* Detail panel */}
      {selected && <KnowledgeDetail row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
