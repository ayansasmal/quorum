import { useState } from 'react'
import { useAudit } from '../api/audit.js'
import AuditEntry from '../components/audit/AuditEntry.jsx'

const TOOLS = ['remember', 'recall', 'search', 'review', 'forget', 'reflect', 'bump']

export default function Audit() {
  const [tool,   setTool]   = useState('')
  const [author, setAuthor] = useState('')
  const [topic,  setTopic]  = useState('')

  const { data, isLoading, error } = useAudit({
    tool:   tool   || undefined,
    author: author || undefined,
    topic:  topic  || undefined,
    limit:  100,
  })

  const entries = data?.entries ?? data ?? []

  return (
    <div className="space-y-4 max-w-3xl">

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <option value="">All operations</option>
          {TOOLS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          placeholder="Filter by author…"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          placeholder="Filter by topic…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Timeline */}
      {isLoading ? (
        <p className="text-sm text-gray-600 text-center py-8">Loading audit log…</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-4">{error.message}</p>
      ) : !entries.length ? (
        <p className="text-sm text-gray-600 text-center py-8">No audit entries found.</p>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4">
          {entries.map((entry) => (
            <AuditEntry key={entry.entry_id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
