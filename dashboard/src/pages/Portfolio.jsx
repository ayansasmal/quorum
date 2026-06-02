// dashboard/src/pages/Portfolio.jsx
import { useState, useMemo } from 'react'
import { usePortfolio }      from '../api/conformance.js'

/** Score colour based on value (green ≥80, amber 50-79, red <50, grey = no score). */
function scoreColor(score) {
  if (score === null || score === undefined) return 'text-gray-400'
  if (score >= 80) return 'text-green-400'
  if (score >= 50) return 'text-amber-400'
  return 'text-red-400'
}

/** Score bar fill colour (matches scoreColor). */
function barColor(score) {
  if (score === null || score === undefined) return ''
  if (score >= 80) return 'bg-green-400'
  if (score >= 50) return 'bg-amber-400'
  return 'bg-red-400'
}

/** "3 days ago" / "Yesterday" / "Today" relative label. */
function relativeDate(iso) {
  if (!iso) return null
  const diffMs    = Date.now() - new Date(iso).getTime()
  const diffDays  = Math.floor(diffMs / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30)  return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`
}

export default function Portfolio() {
  const { data, isLoading, error } = usePortfolio()
  const projects = data?.projects ?? []
  const rollup   = data?.rollup   ?? null

  if (isLoading) return <p className="text-sm text-gray-500 py-8 text-center">Loading portfolio…</p>
  if (error)     return <p className="text-sm text-red-400 py-8 text-center">{error.message}</p>

  const rollupColor = scoreColor(rollup?.score)

  const bannerClass = rollup?.score >= 80
    ? 'border-green-900/40 bg-green-950/20 dark:border-green-900/40 dark:bg-green-950/20'
    : rollup?.score >= 50
    ? 'border-amber-900/40 bg-amber-950/20 dark:border-amber-900/40 dark:bg-amber-950/20'
    : rollup?.score !== null && rollup?.score !== undefined
    ? 'border-red-900/40 bg-red-950/20 dark:border-red-900/40 dark:bg-red-950/20'
    : 'border-gray-700 bg-gray-800/30 dark:border-gray-700 dark:bg-gray-800/30'

  return (
    <div className="space-y-5 max-w-6xl">

      {/* ── Rollup banner ─────────────────────────────────────── */}
      <div className={`flex items-center gap-6 rounded-lg border ${bannerClass} px-5 py-4`}>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">
            Org conformance score
          </p>
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-black ${rollupColor}`}>
              {rollup?.score ?? '—'}
            </span>
            <span className={`text-xs font-semibold ${rollupColor}`}>
              {rollup?.status ?? 'UNCERTIFIED'}
            </span>
          </div>
        </div>

        <div className="w-px h-10 bg-gray-800" />

        <div className="flex gap-6 text-center">
          {[
            { label: 'Certified',   value: rollup?.certified_count   ?? 0, color: 'text-green-400' },
            { label: 'Uncertified', value: rollup?.uncertified_count ?? 0, color: 'text-gray-400'  },
            { label: 'Total',       value: projects.length,                color: 'text-gray-200'  },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div className={`text-xl font-bold ${color}`}>{value}</div>
              <div className="text-[9px] uppercase tracking-widest text-gray-500">{label}</div>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}
