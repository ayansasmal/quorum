import { useState } from 'react'
import { useStats } from '../api/stats.js'
import DomainChart from '../components/stats/DomainChart.jsx'
import ConfidenceHistogram from '../components/stats/ConfidenceHistogram.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import DecayingKnowledge from '../components/stats/DecayingKnowledge.jsx'
import { fmtAge, fmtDate } from '../lib/utils.js'

const TABS = ['Overview', 'Decaying Knowledge']

export default function Stats() {
  const [tab, setTab] = useState('Overview')
  const { data, isLoading, error } = useStats()

  if (isLoading) return <LoadingState />
  if (error)     return <ErrorState message={error.message} />

  const { domains = [], pending, confidence, lowest_confidence = [], most_accessed = [] } = data ?? {}

  return (
    <div className="space-y-6">

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Decaying Knowledge' && <DecayingKnowledge />}
      {tab === 'Overview' && (<div className="space-y-6">

      {/* Top row — summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total domains"    value={domains.length} />
        <StatCard label="Active knowledge" value={domains.reduce((s, d) => s + (d.active_count ?? 0), 0)} />
        <StatCard
          label="Pending decisions"
          value={pending?.total ?? 0}
          sub={pending?.avg_age_hours ? `avg ${fmtAge(pending.avg_age_hours)} old` : null}
          warn={pending?.total > 0}
        />
        <StatCard label="Oldest pending" value={pending?.oldest_age_hours ? fmtAge(pending.oldest_age_hours) : '—'} />
      </div>

      {/* Domain chart + confidence histogram */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Active knowledge by domain">
          <DomainChart domains={domains} />
        </Card>
        <Card title="Confidence distribution">
          <div className="pt-2">
            <ConfidenceHistogram confidence={confidence} />
          </div>
          <div className="mt-4 grid grid-cols-3 text-center text-xs text-gray-500">
            <div><span className="text-green-400 font-medium">{confidence?.high ?? 0}</span> high</div>
            <div><span className="text-amber-400 font-medium">{confidence?.medium ?? 0}</span> medium</div>
            <div><span className="text-red-400 font-medium">{confidence?.low ?? 0}</span> low</div>
          </div>
        </Card>
      </div>

      {/* Lowest confidence + most accessed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Lowest confidence — candidates for refresh">
          <KnowledgeTable
            rows={lowest_confidence}
            cols={[
              { key: 'topic', label: 'Domain' },
              { key: 'key',   label: 'Key' },
              {
                key: 'confidence', label: 'Confidence',
                render: (v) => <ConfidenceBar value={v} showLabel className="min-w-[100px]" />,
              },
              { key: 'last_accessed_at', label: 'Last access', render: fmtDate },
            ]}
          />
        </Card>

        <Card title="Most accessed knowledge">
          <KnowledgeTable
            rows={most_accessed}
            cols={[
              { key: 'topic',        label: 'Domain' },
              { key: 'key',          label: 'Key' },
              { key: 'access_count', label: 'Recalls', render: (v) => <span className="font-mono">{v}</span> },
              {
                key: 'confidence', label: 'Confidence',
                render: (v) => <ConfidenceBar value={v} showLabel className="min-w-[100px]" />,
              },
            ]}
          />
        </Card>
      </div>

    </div>)}

    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, warn }) {
  return (
    <div className={`rounded-lg border p-4 ${warn ? 'border-amber-700/50 bg-amber-900/10' : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900'}`}>
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${warn ? 'text-amber-400' : 'text-gray-900 dark:text-white'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-600">{sub}</p>}
    </div>
  )
}

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</h2>
      {children}
    </div>
  )
}

function KnowledgeTable({ rows, cols }) {
  if (!rows.length) return <p className="text-sm text-gray-600 py-4 text-center">No data</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-800">
            {cols.map((c) => (
              <th key={c.key} className="pb-2 pr-4 text-left text-xs font-medium text-gray-500">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-100 dark:hover:bg-gray-800/30">
              {cols.map((c) => (
                <td key={c.key} className="py-2 pr-4 text-gray-600 dark:text-gray-300">
                  {c.render ? c.render(row[c.key]) : row[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex h-64 items-center justify-center text-gray-600 text-sm">
      Loading stats…
    </div>
  )
}

function ErrorState({ message }) {
  return (
    <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
      Failed to load stats: {message}
    </div>
  )
}
