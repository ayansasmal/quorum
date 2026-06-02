# Portfolio Intelligence — UI Design Spec

**Date:** 2026-06-03  
**Gap:** GAP-028  
**Status:** Approved — ready for implementation

---

## Context

`GET /api/portfolio` is fully implemented and tested (S-07.4). It returns all
projects with conformance scores and an org-wide rollup. The dashboard has no
dedicated Portfolio page — conformance appears only as a card on the Stats page.
This spec describes the full-page Portfolio view.

Auth guard (`PORTFOLIO_ROLES`) is intentionally deferred — the page will be
wired as a standard MemberRoute during implementation and the guard added
afterwards (tracked in task #13).

---

## Design Summary

A single scrollable page: **rollup banner → cascading org filters → project table**.
No modals, no drill-down panels, no tabs. Filtering and scanning is the primary job.

---

## 1. Rollup Banner

Pinned at the top of the page content (not sticky). Shows the org-wide aggregated
score from `rollup` in the API response.

**Fields:**
- Org conformance score (large, colour-coded: green ≥80, amber 50–79, red <50, grey if null/UNCERTIFIED)
- Status label: `CERTIFIED` or `UNCERTIFIED`
- Certified count
- Uncertified count
- Total project count

When `rollup === null` (no CERTIFIED projects at all), show a grey UNCERTIFIED
state with zero counts.

---

## 2. Cascading Org Filters

Four filter controls in a single row, each narrowing the next:

```
[ Group ▾ ]  [ Division ▾ ]  [ Department ▾ ]  [ Status ▾ ]  [ Search…_________ ]
```

**Cascade logic (all client-side — no re-fetch):**

1. **Group** — lists all unique `hierarchy_level === 'group'` projects by display name.
   Selecting one sets `selectedGroup`.
2. **Division** — lists projects where `hierarchy_parent === selectedGroup.group_id`
   and `hierarchy_level === 'division'`. Disabled and shows `—` when no group selected.
   Selecting one sets `selectedDivision`.
3. **Department** — lists projects where `hierarchy_parent === selectedDivision.group_id`
   and `hierarchy_level === 'department'`. Disabled when no division selected.
4. **Status** — `All / CERTIFIED / UNCERTIFIED`. Independent of org cascade.
5. **Search** — free-text match on `group_id` or `display_name`. Independent.

Changing a parent filter resets all downstream filters (Group change → clears Division
and Department; Division change → clears Department only).

Result count shown below filters: `Showing N of M projects`.

**Filter application:** The displayed rows are the intersection of all active filters.
Org cascade filters match projects that are *descendants* at any depth of the selected
node — not just direct children — so selecting a group shows all services/apps within
it regardless of intermediate levels.

---

## 3. Project Table

Three columns rendered as a standard `<table>`:

| Column | Source | Notes |
|--------|--------|-------|
| **Project** | `display_name` + `group_id` | `display_name` as primary; `group_id` as monospace subtitle |
| **Owner** | `owner` | GitHub username; plain text |
| **Last scan** | `last_scan_at` | Relative time (e.g. "3 days ago"); tooltip shows full ISO date. Grey "Never" when null |
| **Score** | `score` | Coloured bar (full width) + number right-aligned. Colour: green ≥80, amber 50–79, red <50, grey when UNCERTIFIED |
| **Status** | `status` | Badge: `● CERTIFIED` (colour-matched to score) or `○ UNCERTIFIED` (grey) |

Global catalog projects show a small `GLOBAL` pill next to the display name.

Rows are sorted by score descending by default (UNCERTIFIED rows — no score — sort to
the bottom). No additional sort controls in v1.

---

## 4. Gateway Change (minor)

`GET /api/portfolio` must return three additional fields per project. All are already
loaded via `loadProjectConfig` inside the route — they just need to be included in
the response map:

```js
// Add to projects: scores.map((p) => ({ ... }))
owner:            p.owner    ?? null,
hierarchy_parent: p.hierarchyParent ?? null,
is_global:        p.isGlobal ?? false,
```

And in `projectInfos` construction:
```js
owner:          cfg?.owner ?? null,
hierarchyParent: cfg?.hierarchy?.parent ?? null,
isGlobal:       cfg?.is_global ?? false,
```

---

## 5. Dashboard Wiring

**New file:** `dashboard/src/pages/Portfolio.jsx`

**Hook:** `usePortfolio()` from `dashboard/src/api/conformance.js` — already built,
`staleTime: 120s`, `retry: false`.

**Sidebar:** Add `Portfolio` nav item with `TrendingUp` icon (lucide-react) between
Deviations and Knowledge.

**Layout:** Add `'/portfolio': 'Portfolio Intelligence'` to `PAGE_TITLES` in
`Layout.jsx`.

**Route:** Register `/portfolio` as a `MemberRoute` in `App.jsx`. Auth guard
(`PORTFOLIO_ROLES`) to be added in a follow-up (task #13).

---

## 6. Filtering Implementation

The cascade is derived from the flat `projects[]` array using `useMemo`:

```js
// Unique groups: projects whose hierarchy_level === 'group'
const groups = useMemo(() =>
  projects.filter(p => p.hierarchy_level === 'group'), [projects])

// Divisions: direct children of selectedGroup
const divisions = useMemo(() =>
  selectedGroup
    ? projects.filter(p => p.hierarchy_parent === selectedGroup && p.hierarchy_level === 'division')
    : [], [projects, selectedGroup])

// Departments: direct children of selectedDivision
const departments = useMemo(() =>
  selectedDivision
    ? projects.filter(p => p.hierarchy_parent === selectedDivision && p.hierarchy_level === 'department')
    : [], [projects, selectedDivision])

// Final filtered rows: descendants at any depth of the selected org node
const filtered = useMemo(() => {
  let rows = projects
  if (selectedDepartment) rows = rows.filter(p => p.hierarchy_parent === selectedDepartment)
  else if (selectedDivision) rows = rows.filter(p => isDescendant(p, selectedDivision, projects))
  else if (selectedGroup)    rows = rows.filter(p => isDescendant(p, selectedGroup, projects))
  if (selectedStatus) rows = rows.filter(p => p.status === selectedStatus)
  if (query) rows = rows.filter(p =>
    p.group_id.includes(query) || (p.display_name ?? '').toLowerCase().includes(query.toLowerCase()))
  return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
}, [projects, selectedGroup, selectedDivision, selectedDepartment, selectedStatus, query])
```

`isDescendant(project, ancestorGroupId, allProjects)` — walks `hierarchy_parent`
up the tree until it either matches `ancestorGroupId` (true) or hits a root (false).

---

## 7. Score Bar Component

Reuse the existing `ConfidenceBar` pattern from `dashboard/src/components/stats/ConfidenceBar.jsx`
for visual consistency. The score bar needs colour-switching (green/amber/red/grey) based on
value thresholds — `ConfidenceBar` may need a `scoreMode` prop or the Portfolio page
implements its own inline bar to avoid coupling.

Recommendation: inline bar in `Portfolio.jsx` (5 lines of JSX) to keep the component
self-contained.

---

## 8. Out of Scope (v1)

- Row click / project drill-down
- Sort controls (default sort only: score descending)
- Export
- PORTFOLIO_ROLES auth guard (follow-up, task #13)

---

## Verification

1. `npm run docker:start --env=dev` → navigate to `http://localhost:3002/portfolio`
2. Rollup banner shows org score
3. Group filter populates from projects data; selecting group narrows Division
4. Division selection narrows Department; Department change resets downstream
5. Status filter works independently
6. Search matches on name and group_id
7. Score bar colour-coded correctly; UNCERTIFIED rows at bottom
8. `npm run build --workspace=dashboard` → nginx picks up new dist
9. `npm run test:gateway` — portfolio route unit test updated for new fields
