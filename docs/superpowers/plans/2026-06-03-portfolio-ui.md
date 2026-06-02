# Portfolio Intelligence UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Portfolio Intelligence page — org-filtered project table with conformance scores, cascading Group→Division→Department filters, and an org-wide rollup banner.

**Architecture:** One gateway field addition (`owner`, `hierarchy_parent`, `is_global` in `GET /api/portfolio`) + one new React page (`Portfolio.jsx`) + three wiring changes (Sidebar, Layout, App). All filtering is client-side over the already-fetched `usePortfolio()` data — no extra API calls.

**Tech Stack:** React 19, TanStack Query 5, React Router 7, lucide-react, Tailwind CSS, Vite

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `gateway/src/routes/dashboard.js` | Add `owner`, `hierarchyParent`, `isGlobal` to `projectInfos`; add to response map |
| Modify | `tests/gateway/dashboard-conformance.test.js` | Update existing portfolio test; add new fields assertion test |
| **Create** | `dashboard/src/pages/Portfolio.jsx` | Full Portfolio page — rollup banner, cascading filters, project table |
| Modify | `dashboard/src/components/layout/Sidebar.jsx` | Add `TrendingUp` nav item between Deviations and Knowledge |
| Modify | `dashboard/src/components/layout/Layout.jsx` | Add `'/portfolio': 'Portfolio Intelligence'` to `PAGE_TITLES` |
| Modify | `dashboard/src/App.jsx` | Import `Portfolio`; add `<Route path="/portfolio">` inside `MemberRoute` |

---

## Task 1 — Extend GET /api/portfolio with owner, hierarchy_parent, is_global

**Files:**
- Modify: `gateway/src/routes/dashboard.js`
- Modify: `tests/gateway/dashboard-conformance.test.js`

- [ ] **Step 1: Write a failing test asserting the three new fields**

In `tests/gateway/dashboard-conformance.test.js`, after the existing `'returns projects list with rollup'` test (around line 314), add:

```js
it('returns owner, hierarchy_parent, and is_global per project', async () => {
  const mockQuery = vi.fn().mockResolvedValue({
    rows: [{ q_project_id: 'q_p1', group_id: 'payments-service' }],
  })
  mockLoadProjectConfig.mockResolvedValue({
    globals: [],
    owner: 'ayansasmal',
    is_global: false,
    hierarchy: { criticality: 1, level: 'service', parent: 'platform-team' },
  })
  mockGetPortfolioScores.mockResolvedValue([
    { groupId: 'payments-service', qProjectId: 'q_p1', displayName: 'Payments',
      hierarchyLevel: 'service', criticality: 1, score: 88, status: 'CERTIFIED',
      breakdown: { open: 0, accepted: 1, denied: 0, deferred: 0, overdue: 0, resolved: 0 },
      scan_count: 1, last_scan_at: '2026-06-01T00:00:00Z',
      owner: 'ayansasmal', hierarchyParent: 'platform-team', isGlobal: false },
  ])

  const app = makeServer({ role: 'principal_architect' }, { query: mockQuery })
  const { status, body } = await request(app, 'GET', '/api/portfolio')

  expect(status).toBe(200)
  expect(body.projects[0].owner).toBe('ayansasmal')
  expect(body.projects[0].hierarchy_parent).toBe('platform-team')
  expect(body.projects[0].is_global).toBe(false)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm run test:gateway -- --reporter=verbose dashboard-conformance
```

Expected: FAIL — `body.projects[0].owner` is `undefined`.

- [ ] **Step 3: Add the three fields to `projectInfos` construction**

In `gateway/src/routes/dashboard.js`, find the `projectInfos` map (around line 2324). Replace:

```js
return {
  groupId:        group_id,
  qProjectId:     q_project_id,
  catalogGroupIds: cfg?.globals ?? [],
  criticality:    cfg?.hierarchy?.criticality ?? 1,
  displayName:    cfg?.hierarchy?.display_name ?? cfg?.project ?? group_id,
  hierarchyLevel: cfg?.hierarchy?.level ?? null,
}
```

With:

```js
return {
  groupId:         group_id,
  qProjectId:      q_project_id,
  catalogGroupIds: cfg?.globals ?? [],
  criticality:     cfg?.hierarchy?.criticality ?? 1,
  displayName:     cfg?.hierarchy?.display_name ?? cfg?.project ?? group_id,
  hierarchyLevel:  cfg?.hierarchy?.level   ?? null,
  hierarchyParent: cfg?.hierarchy?.parent  ?? null,
  owner:           cfg?.owner              ?? null,
  isGlobal:        cfg?.is_global          ?? false,
}
```

- [ ] **Step 4: Add the three fields to the response map**

In `gateway/src/routes/dashboard.js`, find `scores.map((p) => ({` (around line 2356). Add after `hierarchy_level: p.hierarchyLevel,`:

```js
hierarchy_parent: p.hierarchyParent ?? null,
owner:            p.owner           ?? null,
is_global:        p.isGlobal        ?? false,
```

- [ ] **Step 5: Update the existing "returns projects list with rollup" mock**

The existing test's `mockGetPortfolioScores` return value now needs the three new fields or the score object won't carry them. In `tests/gateway/dashboard-conformance.test.js` around line 291, add to each score object:

```js
owner: null, hierarchyParent: null, isGlobal: false,
```

- [ ] **Step 6: Run all gateway tests and confirm green**

```bash
npm run test:gateway
```

Expected: all tests pass (was 704 before this task; should now be 705+).

- [ ] **Step 7: Commit**

```bash
git add gateway/src/routes/dashboard.js tests/gateway/dashboard-conformance.test.js
git commit -m "feat(portfolio): add owner, hierarchy_parent, is_global to GET /api/portfolio response"
```

---

## Task 2 — Create Portfolio.jsx: rollup banner + skeleton

**Files:**
- Create: `dashboard/src/pages/Portfolio.jsx`

- [ ] **Step 1: Create the file with rollup banner only**

```jsx
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

/** "3 days ago" / "Just now" relative label. */
function relativeDate(iso) {
  if (!iso) return null
  const diffMs  = Date.now() - new Date(iso).getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)
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

  const rollupColor = rollup?.score >= 80 ? 'text-green-400'
    : rollup?.score >= 50 ? 'text-amber-400'
    : rollup?.score !== null && rollup?.score !== undefined ? 'text-red-400'
    : 'text-gray-400'

  return (
    <div className="space-y-5 max-w-6xl">

      {/* ── Rollup banner ─────────────────────────────────────── */}
      <div className="flex items-center gap-6 rounded-lg border border-green-900/40 bg-green-950/20 px-5 py-4">
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
```

- [ ] **Step 2: Verify the file is syntactically valid**

```bash
node --input-type=module --eval "import('./dashboard/src/pages/Portfolio.jsx')" 2>&1 | head -5
```

Expected: no output (or ESM import note — no errors).

- [ ] **Step 3: Commit skeleton**

```bash
git add dashboard/src/pages/Portfolio.jsx
git commit -m "feat(portfolio): add Portfolio page skeleton with rollup banner"
```

---

## Task 3 — Cascading filters

**Files:**
- Modify: `dashboard/src/pages/Portfolio.jsx`

- [ ] **Step 1: Add filter state and cascade logic inside Portfolio()**

Add the following between `const projects = data?.projects ?? []` and the `if (isLoading)` guard:

```jsx
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
```

- [ ] **Step 2: Add the filter row JSX after the rollup banner div**

```jsx
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
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/Portfolio.jsx
git commit -m "feat(portfolio): add cascading org filters (group → division → department)"
```

---

## Task 4 — Project table

**Files:**
- Modify: `dashboard/src/pages/Portfolio.jsx`

- [ ] **Step 1: Add the project table JSX after the result count `<p>`**

```jsx
{/* ── Project table ───────────────────────────────────────── */}
<div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
  <table className="w-full text-sm">
    <thead className="border-b border-gray-800 bg-gray-950">
      <tr>
        {['Project', 'Owner', 'Last scan', 'Score', 'Status'].map(h => (
          <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-800/60">
      {filtered.length === 0 ? (
        <tr>
          <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-600">
            No projects match the current filters.
          </td>
        </tr>
      ) : filtered.map(p => (
        <tr key={p.group_id} className="hover:bg-gray-800/30">
          {/* Project */}
          <td className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-100 font-mono text-xs">{p.display_name ?? p.group_id}</span>
              {p.is_global && (
                <span className="text-[9px] font-semibold border border-indigo-700 bg-indigo-900/30 text-indigo-400 rounded px-1 py-0.5">GLOBAL</span>
              )}
            </div>
            {p.display_name && (
              <div className="text-[10px] text-gray-600 font-mono mt-0.5">{p.group_id}</div>
            )}
          </td>

          {/* Owner */}
          <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
            {p.owner ?? <span className="text-gray-700">—</span>}
          </td>

          {/* Last scan */}
          <td className="px-4 py-3 text-xs whitespace-nowrap">
            {p.last_scan_at ? (
              <span title={p.last_scan_at} className="text-gray-400 cursor-help">
                {relativeDate(p.last_scan_at)}
              </span>
            ) : (
              <span className="text-gray-700">Never</span>
            )}
          </td>

          {/* Score bar */}
          <td className="px-4 py-3 min-w-[140px]">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-gray-800 rounded-full">
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
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-2 py-0.5
                ${p.score >= 80 ? 'border-green-800 bg-green-950/40 text-green-400'
                  : p.score >= 50 ? 'border-amber-800 bg-amber-950/40 text-amber-400'
                  : 'border-red-800 bg-red-950/40 text-red-400'}`}>
                ● CERTIFIED
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border border-gray-700 bg-gray-800/40 text-gray-500 px-2 py-0.5">
                ○ UNCERTIFIED
              </span>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/pages/Portfolio.jsx
git commit -m "feat(portfolio): add project table with score bar, owner, last scan columns"
```

---

## Task 5 — Wire into dashboard (Sidebar, Layout, App)

**Files:**
- Modify: `dashboard/src/components/layout/Sidebar.jsx`
- Modify: `dashboard/src/components/layout/Layout.jsx`
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Add TrendingUp to Sidebar imports and NAV array**

In `dashboard/src/components/layout/Sidebar.jsx`, update the import line:

```js
import {
  BarChart2, GitBranch, Clock, BookOpen,
  List, Settings, Activity, LogOut, Shield, AlertTriangle, TrendingUp,
} from 'lucide-react'
```

In the `NAV` array, add after the Deviations entry and before Knowledge:

```js
{ to: '/portfolio', icon: TrendingUp, label: 'Portfolio' },
```

Final NAV order:
```js
const NAV = [
  { to: '/',           icon: BarChart2,    label: 'Stats',      guestOk: true },
  { to: '/graph',      icon: GitBranch,    label: 'Graph',      guestOk: true },
  { to: '/pending',    icon: List,         label: 'Pending',    badge: true   },
  { to: '/deviations', icon: AlertTriangle,label: 'Deviations'               },
  { to: '/portfolio',  icon: TrendingUp,   label: 'Portfolio'                },
  { to: '/knowledge',  icon: BookOpen,     label: 'Knowledge',  guestOk: true },
  { to: '/audit',      icon: Clock,        label: 'Audit'                    },
  { to: '/config',     icon: Settings,     label: 'Config'                   },
  { to: '/status',     icon: Activity,     label: 'Status'                   },
]
```

- [ ] **Step 2: Add Portfolio title to Layout.jsx**

In `dashboard/src/components/layout/Layout.jsx`, add to `PAGE_TITLES`:

```js
'/portfolio': 'Portfolio Intelligence',
```

- [ ] **Step 3: Add route to App.jsx**

In `dashboard/src/App.jsx`, add the import at the top with other page imports:

```js
import Portfolio from './pages/Portfolio.jsx'
```

Inside the `<Route element={<MemberRoute />}>` block, add:

```jsx
<Route path="/portfolio" element={<Portfolio />} />
```

Full MemberRoute block becomes:

```jsx
<Route element={<MemberRoute />}>
  <Route path="/pending"    element={<Pending />} />
  <Route path="/deviations" element={<Deviations />} />
  <Route path="/portfolio"  element={<Portfolio />} />
  <Route path="/audit"      element={<Audit />} />
  <Route path="/config"     element={<Config />} />
  <Route path="/status"     element={<Status />} />
</Route>
```

- [ ] **Step 4: Commit all wiring**

```bash
git add dashboard/src/components/layout/Sidebar.jsx \
        dashboard/src/components/layout/Layout.jsx \
        dashboard/src/App.jsx
git commit -m "feat(portfolio): wire Portfolio page into sidebar nav, layout titles, and router"
```

---

## Task 6 — Build dashboard and smoke test

**Files:** none (build + verify only)

- [ ] **Step 1: Build the dashboard**

```bash
npm run build --workspace=dashboard
```

Expected: `✓ built in <N>ms` with no errors. Chunk size warnings are OK.

- [ ] **Step 2: Verify nginx picks up the new build**

```bash
curl -si http://localhost:3002/portfolio | head -3
```

Expected: `HTTP/1.1 200 OK` (nginx serves `index.html` for the SPA route).

- [ ] **Step 3: Open the page and verify the rollup banner**

Navigate to `http://localhost:3002/portfolio` in the browser.

- Rollup banner should show org score (or UNCERTIFIED if no scans have run in this env).
- Portfolio nav item (`TrendingUp` icon) should be highlighted in Sidebar.
- Page title in header should read "Portfolio Intelligence".

- [ ] **Step 4: Verify filter cascade**

If the dev stack has projects with hierarchy configured:
- Selecting a Group should populate Division dropdown.
- Selecting a Division should enable Department; changing Group should clear both Division and Department.
- Clearing Group should reset all cascade dropdowns.
- Status and Search filters work independently.

If no hierarchy is configured in dev data, the Group dropdown will be empty — this is correct behaviour (no group-level projects seeded). The table still shows all projects unfiltered.

- [ ] **Step 5: Run gateway unit tests to confirm no regressions**

```bash
npm run test:gateway
```

Expected: all tests pass.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(portfolio): complete portfolio intelligence page (gap-028)"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - Rollup banner: Task 2 ✅
  - Cascading filters (Group→Division→Department→Status→Search): Task 3 ✅
  - isDescendant logic (shows descendants at any depth, not just direct children): Task 3 ✅
  - Project table (Project · Owner · Last scan · Score · Status): Task 4 ✅
  - Score colour thresholds (≥80 green, 50–79 amber, <50 red, null grey): Tasks 2+4 ✅
  - GLOBAL pill: Task 4 ✅
  - Sort (score desc, UNCERTIFIED at bottom): Task 3 ✅
  - Gateway fields (owner, hierarchy_parent, is_global): Task 1 ✅
  - Sidebar, Layout, App wiring: Task 5 ✅
  - Auth guard deferred: not in this plan (tracked in task #13) ✅

- **Type consistency:**
  - `p.hierarchyParent` in gateway (camelCase internal) → `hierarchy_parent` in response (snake_case) — consistent across Task 1 ✅
  - `scoreColor(score)` / `barColor(score)` defined in Task 2, used in Task 4 ✅
  - `relativeDate(iso)` defined in Task 2, used in Task 4 ✅
  - `isDescendant(project, ancestorGroupId)` defined in Task 3, used in `filtered` useMemo in Task 3 ✅

- **No placeholders:** All steps contain exact code. ✅
