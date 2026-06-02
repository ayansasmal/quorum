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

  // ── Filter state ───────────────────────────────────────────
  const [selectedGroup,      setSelectedGroup]      = useState('')
  const [selectedDivision,   setSelectedDivision]   = useState('')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedStatus,     setSelectedStatus]     = useState('')
  const [query,              setQuery]              = useState('')

  // ── Cascade option lists (derived from flat projects array) ─
  const groups = useMemo(
    () => projects.filter(p => p.hierarchy_level === 'group'),
    [projects],
  )

  const divisions = useMemo(
    () => selectedGroup
      ? projects.filter(p => p.hierarchy_parent === selectedGroup && p.hierarchy_level === 'division')
      : [],
    [projects, selectedGroup],
  )

  const departments = useMemo(
    () => selectedDivision
      ? projects.filter(p => p.hierarchy_parent === selectedDivision && p.hierarchy_level === 'department')
      : [],
    [projects, selectedDivision],
  )

  // Walk hierarchy_parent chain to check ancestry.
  function isDescendant(project, ancestorGroupId) {
    const map = new Map(projects.map(p => [p.group_id, p]))
    let cur = map.get(project.hierarchy_parent)
    while (cur) {
      if (cur.group_id === ancestorGroupId) return true
      cur = map.get(cur.hierarchy_parent)
    }
    return false
  }

  // ── Filtered + sorted rows ─────────────────────────────────
  const filtered = useMemo(() => {
    let rows = projects
    if (selectedDepartment) {
      rows = rows.filter(p => p.hierarchy_parent === selectedDepartment)
    } else if (selectedDivision) {
      rows = rows.filter(p => p.hierarchy_parent === selectedDivision || isDescendant(p, selectedDivision))
    } else if (selectedGroup) {
      rows = rows.filter(p => p.hierarchy_parent === selectedGroup || isDescendant(p, selectedGroup))
    }
    if (selectedStatus) rows = rows.filter(p => p.status === selectedStatus)
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(p =>
        p.group_id.toLowerCase().includes(q) ||
        (p.display_name ?? '').toLowerCase().includes(q),
      )
    }
    // CERTIFIED rows sorted by score desc; UNCERTIFIED rows at bottom
    return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  }, [projects, selectedGroup, selectedDivision, selectedDepartment, selectedStatus, query])

  // Reset downstream filters when a parent filter changes
  function handleGroupChange(val) {
    setSelectedGroup(val)
    setSelectedDivision('')
    setSelectedDepartment('')
  }
  function handleDivisionChange(val) {
    setSelectedDivision(val)
    setSelectedDepartment('')
  }

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

      {/* ── Cascading filters ───────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={selectedGroup}
          onChange={e => handleGroupChange(e.target.value)}
          className="rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">Group: All</option>
          {groups.map(g => (
            <option key={g.group_id} value={g.group_id}>{g.display_name ?? g.group_id}</option>
          ))}
        </select>

        <select
          value={selectedDivision}
          onChange={e => handleDivisionChange(e.target.value)}
          disabled={!selectedGroup}
          className="rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-300 disabled:opacity-40"
        >
          <option value="">Division: {selectedGroup ? 'All' : '—'}</option>
          {divisions.map(d => (
            <option key={d.group_id} value={d.group_id}>{d.display_name ?? d.group_id}</option>
          ))}
        </select>

        <select
          value={selectedDepartment}
          onChange={e => setSelectedDepartment(e.target.value)}
          disabled={!selectedDivision}
          className="rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-300 disabled:opacity-40"
        >
          <option value="">Department: {selectedDivision ? 'All' : '—'}</option>
          {departments.map(d => (
            <option key={d.group_id} value={d.group_id}>{d.display_name ?? d.group_id}</option>
          ))}
        </select>

        <select
          value={selectedStatus}
          onChange={e => setSelectedStatus(e.target.value)}
          className="rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">Status: All</option>
          <option value="CERTIFIED">CERTIFIED</option>
          <option value="UNCERTIFIED">UNCERTIFIED</option>
        </select>

        <input
          type="text"
          placeholder="Search by name or group_id…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="flex-1 min-w-[180px] rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <p className="text-xs text-gray-600">
        Showing {filtered.length} of {projects.length} projects
        {selectedGroup && ` · group: ${selectedGroup}`}
        {selectedDivision && ` · division: ${selectedDivision}`}
        {selectedDepartment && ` · dept: ${selectedDepartment}`}
        {selectedStatus && ` · ${selectedStatus}`}
      </p>

    </div>
  )
}
