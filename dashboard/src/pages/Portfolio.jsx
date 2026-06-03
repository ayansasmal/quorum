// dashboard/src/pages/Portfolio.jsx
import { useState, useMemo } from 'react'
import { usePortfolio }      from '../api/conformance.js'

/** Score colour — darker in light mode, brighter in dark mode. */
function scoreColor(score) {
  if (score === null || score === undefined) return 'text-gray-400'
  if (score >= 80) return 'text-green-600 dark:text-green-400'
  if (score >= 50) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

/** Score bar fill colour. */
function barColor(score) {
  if (score === null || score === undefined) return ''
  if (score >= 80) return 'bg-green-500 dark:bg-green-400'
  if (score >= 50) return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-red-500 dark:bg-red-400'
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

const SELECT_CLS = [
  'rounded-md px-3 py-1.5 text-sm',
  'bg-white border border-gray-300 text-gray-700',
  'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300',
  'disabled:opacity-40',
].join(' ')

export default function Portfolio() {
  const { data, isLoading, error } = usePortfolio()
  const projects = data?.projects ?? []
  const rollup   = data?.rollup   ?? null

  // ── Filter state ───────────────────────────────────────────
  const [selectedOrg,        setSelectedOrg]        = useState('')
  const [selectedGroup,      setSelectedGroup]      = useState('')
  const [selectedDivision,   setSelectedDivision]   = useState('')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedStatus,     setSelectedStatus]     = useState('')
  const [query,              setQuery]              = useState('')

  // ── Cascade option lists ────────────────────────────────────
  const orgs = useMemo(
    () => projects.filter(p => p.hierarchy_level === 'org'),
    [projects],
  )
  const groups = useMemo(
    () => selectedOrg
      ? projects.filter(p => p.hierarchy_parent === selectedOrg && p.hierarchy_level === 'group')
      : [],
    [projects, selectedOrg],
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

  function isDescendant(project, ancestorGroupId) {
    const map = new Map(projects.map(p => [p.group_id, p]))
    let cur = map.get(project.hierarchy_parent)
    while (cur) {
      if (cur.group_id === ancestorGroupId) return true
      cur = map.get(cur.hierarchy_parent)
    }
    return false
  }

  const filtered = useMemo(() => {
    let rows = projects
    if (selectedDepartment) {
      rows = rows.filter(p => p.hierarchy_parent === selectedDepartment)
    } else if (selectedDivision) {
      rows = rows.filter(p => p.hierarchy_parent === selectedDivision || isDescendant(p, selectedDivision))
    } else if (selectedGroup) {
      rows = rows.filter(p => p.hierarchy_parent === selectedGroup || isDescendant(p, selectedGroup))
    } else if (selectedOrg) {
      rows = rows.filter(p => p.hierarchy_parent === selectedOrg || isDescendant(p, selectedOrg))
    }
    if (selectedStatus) rows = rows.filter(p => p.status === selectedStatus)
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(p =>
        p.group_id.toLowerCase().includes(q) ||
        (p.display_name ?? '').toLowerCase().includes(q),
      )
    }
    return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  }, [projects, selectedGroup, selectedDivision, selectedDepartment, selectedStatus, query])

  function handleOrgChange(val) {
    setSelectedOrg(val)
    setSelectedGroup('')
    setSelectedDivision('')
    setSelectedDepartment('')
  }
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
  if (error)     return <p className="text-sm text-red-500 dark:text-red-400 py-8 text-center">{error.message}</p>

  const rollupColor = scoreColor(rollup?.score)

  const bannerClass = rollup?.score >= 80
    ? 'border-green-300 bg-green-50 dark:border-green-900/40 dark:bg-green-950/20'
    : rollup?.score >= 50
    ? 'border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20'
    : rollup?.score !== null && rollup?.score !== undefined
    ? 'border-red-300 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20'
    : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/30'

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

        <div className="w-px h-10 bg-gray-200 dark:bg-gray-700" />

        <div className="flex gap-6 text-center">
          {[
            { label: 'Certified',   value: rollup?.certified_count   ?? 0, color: 'text-green-600 dark:text-green-400' },
            { label: 'Uncertified', value: rollup?.uncertified_count ?? 0, color: 'text-gray-500 dark:text-gray-400'  },
            { label: 'Total',       value: projects.length,                color: 'text-gray-800 dark:text-gray-200'  },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div className={`text-xl font-bold ${color}`}>{value}</div>
              <div className="text-[9px] uppercase tracking-widest text-gray-400 dark:text-gray-500">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Cascading filters ───────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <select value={selectedOrg} onChange={e => handleOrgChange(e.target.value)} className={SELECT_CLS}>
          <option value="">Org: All</option>
          {orgs.map(o => (
            <option key={o.group_id} value={o.group_id}>{o.display_name ?? o.group_id}</option>
          ))}
        </select>

        <select value={selectedGroup} onChange={e => handleGroupChange(e.target.value)} disabled={!selectedOrg} className={SELECT_CLS}>
          <option value="">Group: {selectedOrg ? 'All' : '—'}</option>
          {groups.map(g => (
            <option key={g.group_id} value={g.group_id}>{g.display_name ?? g.group_id}</option>
          ))}
        </select>

        <select value={selectedDivision} onChange={e => handleDivisionChange(e.target.value)} disabled={!selectedGroup} className={SELECT_CLS}>
          <option value="">Division: {selectedGroup ? 'All' : '—'}</option>
          {divisions.map(d => (
            <option key={d.group_id} value={d.group_id}>{d.display_name ?? d.group_id}</option>
          ))}
        </select>

        <select value={selectedDepartment} onChange={e => setSelectedDepartment(e.target.value)} disabled={!selectedDivision} className={SELECT_CLS}>
          <option value="">Department: {selectedDivision ? 'All' : '—'}</option>
          {departments.map(d => (
            <option key={d.group_id} value={d.group_id}>{d.display_name ?? d.group_id}</option>
          ))}
        </select>

        <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value)} className={SELECT_CLS}>
          <option value="">Status: All</option>
          <option value="CERTIFIED">CERTIFIED</option>
          <option value="UNCERTIFIED">UNCERTIFIED</option>
        </select>

        <input
          type="text"
          placeholder="Search by name or group_id…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className={[
            'flex-1 min-w-[180px] rounded-md px-3 py-1.5 text-sm',
            'bg-white border border-gray-300 text-gray-700 placeholder-gray-400',
            'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 dark:placeholder-gray-600',
            'focus:outline-none focus:ring-1 focus:ring-blue-500',
          ].join(' ')}
        />
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-600">
        Showing {filtered.length} of {projects.length} projects
        {selectedOrg && ` · org: ${selectedOrg}`}
        {selectedGroup && ` · group: ${selectedGroup}`}
        {selectedDivision && ` · division: ${selectedDivision}`}
        {selectedDepartment && ` · dept: ${selectedDepartment}`}
        {selectedStatus && ` · ${selectedStatus}`}
      </p>

      {/* ── Project table ───────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950">
            <tr>
              {['Project', 'Owner', 'Last scan', 'Score', 'Status'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-600">
                  No projects match the current filters.
                </td>
              </tr>
            ) : filtered.map(p => (
              <tr key={p.group_id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                {/* Project */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100 font-mono text-xs">
                      {p.display_name ?? p.group_id}
                    </span>
                    {p.is_global && (
                      <span className="text-[9px] font-semibold rounded px-1 py-0.5 border border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                        GLOBAL
                      </span>
                    )}
                  </div>
                  {p.display_name && (
                    <div className="text-[10px] text-gray-400 dark:text-gray-600 font-mono mt-0.5">{p.group_id}</div>
                  )}
                </td>

                {/* Owner */}
                <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                  {p.owner ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                </td>

                {/* Last scan */}
                <td className="px-4 py-3 text-xs whitespace-nowrap">
                  {p.last_scan_at ? (
                    <span title={p.last_scan_at} className="text-gray-500 dark:text-gray-400 cursor-help">
                      {relativeDate(p.last_scan_at)}
                    </span>
                  ) : (
                    <span className="text-gray-300 dark:text-gray-600">Never</span>
                  )}
                </td>

                {/* Score bar */}
                <td className="px-4 py-3 min-w-[140px]">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full">
                      {p.score !== null && p.score !== undefined && (
                        <div
                          className={`h-full rounded-full ${barColor(p.score)}`}
                          style={{ width: `${p.score}%` }}
                        />
                      )}
                    </div>
                    <span className={`text-xs font-bold min-w-[24px] text-right ${scoreColor(p.score)}`}>
                      {p.score ?? '—'}
                    </span>
                  </div>
                </td>

                {/* Status */}
                <td className="px-4 py-3">
                  {p.status === 'CERTIFIED' ? (
                    <span className={[
                      'inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-2 py-0.5',
                      p.score >= 80
                        ? 'border-green-400 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-400'
                        : p.score >= 50
                        ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
                        : 'border-red-400 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400',
                    ].join(' ')}>
                      ● CERTIFIED
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border border-gray-300 bg-gray-100 text-gray-500 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-500 px-2 py-0.5">
                      ○ UNCERTIFIED
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}
