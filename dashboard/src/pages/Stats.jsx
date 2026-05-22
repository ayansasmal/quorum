import { useState } from 'react'
import { useStats } from '../api/stats.js'
import { useConformance } from '../api/conformance.js'
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
  const { data: conformanceData } = useConformance()

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

      {/* Conformance scorecard */}
      {conformanceData && <ConformanceCard data={conformanceData} />}

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
    <div className={`rounded-lg border p-4 ${warn ? 'border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10' : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900'}`}>
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>{value}</p>
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

// ── Conformance card ───────────────────────────────────────────────────────────

const SCORE_COLOR = (score) => {
  if (score === null) return 'text-gray-500'
  if (score >= 80)    return 'text-green-600 dark:text-green-400'
  if (score >= 50)    return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

const SCORE_BG = (score) => {
  if (score === null) return 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
  if (score >= 80)    return 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10'
  if (score >= 50)    return 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10'
  return 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10'
}

/**
 * Conformance score card shown in Stats Overview.
 * @param {{ data: import('../api/conformance.js').ConformanceData }} props
 */
function ConformanceCard({ data }) {
  const { score, status, breakdown = {}, last_scan_at, scan_count = 0, catalogs = [] } = data
  const isUncertified = status === 'UNCERTIFIED'
  const staleMs       = 14 * 24 * 60 * 60 * 1000
  const isStale       = last_scan_at && (Date.now() - new Date(last_scan_at).getTime()) > staleMs

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${SCORE_BG(score)}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Conformance score</p>
          <p className={`mt-1 text-3xl font-bold tabular-nums ${SCORE_COLOR(score)}`}>
            {isUncertified ? 'UNCERTIFIED' : `${score}%`}
          </p>
          {isUncertified && (
            <p className="mt-1 text-xs text-gray-500">
              {scan_count === 0
                ? 'No scans run yet — use quorum:scan to generate a baseline score.'
                : catalogs.length === 0
                  ? 'No linked global catalogs — use quorum:onboard to link catalogs.'
                  : 'Catalog coverage too sparse (< 10 ACTIVE entries). Seed global catalogs first.'}
            </p>
          )}
        </div>

        {/* Linked catalogs */}
        {catalogs.length > 0 && (
          <div className="text-right text-xs text-gray-500 shrink-0">
            <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">Linked catalogs</p>
            {catalogs.map((c) => (
              <p key={c.catalog_id}>
                <span className="font-mono">{c.catalog_id}</span>
                <span className="ml-1 text-gray-400">({c.entry_count})</span>
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Breakdown bar — only when CERTIFIED */}
      {!isUncertified && (
        <div className="space-y-1.5">
          <div className="flex gap-1 h-2 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800">
            <BreakdownBar count={breakdown.open      ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-blue-400"   />
            <BreakdownBar count={breakdown.accepted  ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-green-400"  />
            <BreakdownBar count={breakdown.deferred  ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-amber-400"  />
            <BreakdownBar count={breakdown.denied    ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-red-400"    />
            <BreakdownBar count={breakdown.overdue   ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-orange-500" />
            <BreakdownBar count={breakdown.resolved  ?? 0} total={Object.values(breakdown).reduce((a,b) => a+b, 0)} color="bg-gray-300"   />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
            {[
              { label: 'Open',     key: 'open',     color: 'bg-blue-400'   },
              { label: 'Accepted', key: 'accepted', color: 'bg-green-400'  },
              { label: 'Deferred', key: 'deferred', color: 'bg-amber-400'  },
              { label: 'Denied',   key: 'denied',   color: 'bg-red-400'    },
              { label: 'Overdue',  key: 'overdue',  color: 'bg-orange-500' },
              { label: 'Resolved', key: 'resolved', color: 'bg-gray-300'   },
            ].map(({ label, key, color }) => (
              <span key={key} className="flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
                {breakdown[key] ?? 0} {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Scan metadata */}
      <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
        {last_scan_at && (
          <span className={isStale ? 'text-amber-600 dark:text-amber-400' : ''}>
            {isStale ? '⚠ ' : ''}Last scan: {fmtDate(last_scan_at)}
            {isStale ? ' — stale (> 14 days)' : ''}
          </span>
        )}
        {scan_count > 0 && <span>{scan_count} scan{scan_count !== 1 ? 's' : ''} total</span>}
      </div>
    </div>
  )
}

function BreakdownBar({ count, total, color }) {
  if (!count || !total) return null
  const pct = Math.max(1, Math.round((count / total) * 100))
  return <div className={`${color} h-full`} style={{ width: `${pct}%` }} />
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
    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
      Failed to load stats: {message}
    </div>
  )
}
