# Quorum Dashboard — Implementation Plan

> Created: 2026-04-21
> Wave 4 of the implementation plan (see project memory: `project_implementation_plan.md`)
> Design reference: `FRONTEND.md` — read that first for UI decisions, architecture, and API schemas

---

## Current State

### Already built (no rework needed)

| Item | Location | Notes |
|------|----------|-------|
| Gateway ES256 JWT auth | `src/gateway/routes/auth.js` | `POST /auth/token` — GitHub token → JWT |
| JWKS endpoint | `src/gateway/routes/jwks.js` | `GET /.well-known/jwks.json` |
| JWT verify middleware | `src/gateway/middleware/verify-jwt.js` | Attach to all `/api/*` routes |
| Bump endpoint | `src/gateway/routes/bump.js` | Mounted at `/bump/:topic/:key` ← see discrepancy below |
| Pending decisions query | `src/gateway/routes/pg.js` | `GET /pg/pending`, `PATCH /pg/pending/:id` |
| Config fetch | `src/gateway/routes/config.js` | `GET /config/:projectId`, `POST /config/validate` |
| Health endpoint | `src/gateway/server.js` | `GET /health` |
| Audit log query | `src/gateway/routes/pg.js` | `GET /pg/audit` |

### Not yet built

- `src/gateway/routes/dashboard.js` — BFF aggregation routes (`/api/stats`, `/api/graph`, `/api/knowledge`, `/api/search`, `/api/review/:id`)
- `dashboard/` — entire React/Vite frontend (directory does not exist)
- `bump_log` table — referenced in FRONTEND.md bump mechanic but not in `scripts/init-db.sql`

---

## Discrepancy: `/bump` vs `/api/bump`

FRONTEND.md specifies `POST /api/bump/:topic/:key`.
Gateway currently mounts bump at `POST /bump/:topic/:key` (root-level, no `/api` prefix).

**Decision needed before implementation:** move bump into `/api` namespace (requires mounting it in `dashboard.js` or re-mounting in `server.js`) OR keep it at `/bump` and update FRONTEND.md.

**Recommendation:** move it. All dashboard BFF routes live under `/api/`. Bump belongs there — it's a governance action, not a low-level utility. Update `server.js` to remove the existing `/bump` mount and add it to `dashboard.js`.

---

## Pre-Flight: Resolve Before Building

1. **Bump URL namespace** — `/bump` → `/api/bump` (decision above)
2. **Multi-project login UX** — JWT carries one project at a time. Does the login screen show a project picker dropdown (requires `GET /projects` call before auth) or does the user type the project ID? FRONTEND.md leaves this open. Simplest: text input for project_id on the login screen; project picker is a future enhancement.
3. **`bump_log` schema** — add `bump_log` table to `scripts/init-db.sql` before building the bump endpoint. Schema: `(id SERIAL PRIMARY KEY, author TEXT NOT NULL, topic TEXT NOT NULL, key TEXT NOT NULL, project_id TEXT NOT NULL, bumped_at TIMESTAMPTZ NOT NULL, role TEXT NOT NULL, delta_applied NUMERIC NOT NULL)`. Index on `(author, topic, key, project_id, bumped_at DESC)`.
4. **`GET /api/graph` scale limit** — at >500 nodes, FRONTEND.md notes Cytoscape.js degrades. Add a `?domain=` filter as required (not optional) when node count exceeds the threshold. Default behaviour: if no domain filter and total active nodes > 500, return 400 with a message asking the caller to specify a domain.

---

## Implementation Steps

Steps are ordered: backend BFF routes first, then frontend scaffold, then feature-by-feature.

---

### Step 1 — `bump_log` schema migration

**Files to modify:**
- `scripts/init-db.sql` — add `bump_log` table + index

**What to do:**
Add after the existing `knowledge_versions` table definition:

```sql
CREATE TABLE IF NOT EXISTS bump_log (
  id          SERIAL PRIMARY KEY,
  author      TEXT        NOT NULL,
  topic       TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  project_id  TEXT        NOT NULL DEFAULT 'default',
  role        TEXT        NOT NULL,
  delta_applied NUMERIC   NOT NULL,
  bumped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bump_log_cooldown
  ON bump_log (author, topic, key, project_id, bumped_at DESC);
```

**Acceptance:** `docker-compose down -v && docker-compose up` — PostgreSQL starts without errors, `\d bump_log` shows the table.

---

### Step 2 — Gateway BFF routes (`src/gateway/routes/dashboard.js`)

This is the core backend work. One new file, six endpoints, all under `/api/`.

**Files to create:**
- `src/gateway/routes/dashboard.js`

**Files to modify:**
- `src/gateway/server.js` — remove `/bump` mount, add `import dashboardRoutes` + `app.use('/api', verifyJwt, apiLimit, dashboardRoutes)`
- `src/gateway/routes/bump.js` — remove standalone rate limit import (now inherited from `/api` mount)

**Endpoints to implement in `dashboard.js`:**

```
GET  /api/stats
GET  /api/graph?domain=X
GET  /api/knowledge?domain=X&tag=Y&entity_type=Z&page=N&limit=20
GET  /api/search?q=X&domain=Y&limit=10
POST /api/review/:conflictId    { action, note }
POST /api/bump/:topic/:key      (moved from /bump)
```

**Response schemas:** see FRONTEND.md §"New Gateway BFF Routes" — copy the exact field names.

**For `/api/review/:conflictId`:**  
This is the most complex endpoint. It must run inside a single PostgreSQL transaction:
- validate `reviewer !== draft.author` (constitutional rule 4)
- atomically transition `pending_decisions` + `knowledge_versions` status
- write audit entry with correct `triggered_by` value

**For `/api/stats`:**  
One PostgreSQL aggregate query — avoid N queries. Use CTEs. Example structure:
```sql
WITH domain_stats AS (...),
     pending_stats AS (...),
     activity AS (...),
     confidence_buckets AS (...)
SELECT ...
```

**For `/api/graph`:**  
Query `knowledge_versions WHERE status = 'ACTIVE' AND project_id = $1`. Optionally filter by domain. Return Cytoscape.js format (nodes + edges array). For edges, query a `knowledge_edges` table if it exists, or derive SUPERSEDES edges from `supersedes_version` column on `knowledge_versions`.

> **Check:** does `knowledge_versions` have a `supersedes_version` column? If yes, derive SUPERSEDES edges from it. If `knowledge_edges` table doesn't exist, only SUPERSEDES edges are derivable from existing schema — document this limitation in a comment.

**For `/api/search`:**  
Proxy to Graphiti `search_nodes` via `src/graph/client.js`, map response to `{ results: [{ topic, key, entity_type, summary, confidence, score, author, updated_at }] }`.

**Acceptance:** Each endpoint curl-testable with a valid JWT. `/api/stats` returns the documented shape. `/api/review/:id` with a mismatched reviewer returns 403. `/api/bump` with a repeat within 7 days returns 429.

---

### Step 3 — Frontend scaffold (`dashboard/`)

Bootstrap the React/Vite project. No feature code yet — just working build + dev server + routing skeleton.

**Files to create:**
```
dashboard/
├── Dockerfile
├── nginx.conf
├── package.json
├── vite.config.js
├── index.html
├── tailwind.config.js
├── postcss.config.js
└── src/
    ├── main.jsx
    ├── App.jsx              ← React Router setup, route definitions
    ├── context/
    │   └── AuthContext.jsx  ← JWT in-memory state, login/logout actions
    └── pages/
        ├── Login.jsx        ← login form (github token + project_id input)
        ├── Graph.jsx        ← placeholder
        ├── Pending.jsx      ← placeholder
        ├── Knowledge.jsx    ← placeholder
        ├── Audit.jsx        ← placeholder
        ├── Stats.jsx        ← placeholder
        ├── Config.jsx       ← placeholder
        └── Status.jsx       ← placeholder
```

**Dependencies to install:**
```json
{
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "react-router-dom": "^7.0.0",
  "@tanstack/react-query": "^5.0.0",
  "cytoscape": "^3.30.0",
  "cytoscape-dagre": "^2.5.0",
  "cytoscape-cose-bilkent": "^4.1.0"
}
```

**Dev dependencies:** `vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `autoprefixer`

**shadcn/ui:** initialise with `npx shadcn@latest init` after scaffold is up. Install components as needed per section (not all upfront).

**`vite.config.js` — proxy:**
```js
server: {
  proxy: {
    '/auth': 'http://localhost:8002',
    '/api':  'http://localhost:8002',
    '/.well-known': 'http://localhost:8002'
  }
}
```
This proxies API calls to the Gateway in dev mode — no CORS issues, no hardcoded URLs.

**`App.jsx` routing:**
```jsx
<Routes>
  <Route path="/login" element={<Login />} />
  <Route element={<ProtectedRoute />}>
    <Route path="/"         element={<Stats />} />
    <Route path="/graph"    element={<Graph />} />
    <Route path="/pending"  element={<Pending />} />
    <Route path="/knowledge" element={<Knowledge />} />
    <Route path="/audit"    element={<Audit />} />
    <Route path="/config"   element={<Config />} />
    <Route path="/status"   element={<Status />} />
  </Route>
</Routes>
```

**`AuthContext.jsx` — JWT in memory:**
```jsx
// Store JWT in state only — never localStorage or sessionStorage
// On page refresh: JWT is lost, user sees login screen (intended)
// Decode JWT client-side (jose or manual base64 decode) to extract sub/project/role/team
```

**docker-compose addition:** add `quorum-dashboard` service per FRONTEND.md §"docker-compose Additions".

**Acceptance:** `npm run dev` inside `dashboard/` starts on :5173. Login page renders. Navigating to `/graph` without a token redirects to `/login`.

---

### Step 4 — Auth flow (Login → JWT → all pages reachable)

**Files to modify:**
- `dashboard/src/pages/Login.jsx` — real form: GitHub PAT input + project_id input + submit
- `dashboard/src/context/AuthContext.jsx` — real `POST /auth/token` call, JWT decode, store in state
- `dashboard/src/api/auth.js` — fetch wrapper for auth call

**Acceptance:** Enter a valid GitHub PAT + project_id → lands on Stats page. Enter invalid token → error message shown. JWT expiry (1h): re-auth prompt appears (TanStack Query 401 interceptor triggers logout).

---

### Step 5 — Layout (Sidebar + Header)

**Files to create:**
- `dashboard/src/components/layout/Sidebar.jsx`
- `dashboard/src/components/layout/Header.jsx`
- `dashboard/src/components/layout/Layout.jsx`
- `dashboard/src/api/stats.js` — `useQuery` hook for `GET /api/stats` (used for badge count)

**Sidebar items:** Graph | Pending (badge: pending count) | Knowledge | Audit | Stats | Config | Status

**Header:** shows current user (`sub` from JWT) + project name + logout button.

**Acceptance:** All nav links work. Pending badge shows correct count from `/api/stats`. Active route is highlighted.

---

### Step 6 — Stats Panel

**Files to create:**
- `dashboard/src/pages/Stats.jsx`
- `dashboard/src/components/stats/StatsPanel.jsx`
- `dashboard/src/components/stats/DomainChart.jsx`       ← bar chart (domains × active count)
- `dashboard/src/components/stats/ConfidenceHistogram.jsx` ← bucket histogram
- `dashboard/src/api/stats.js` ← already created in Step 5; extend if needed

**What to build:** domain bar chart, confidence histogram, pending stats, activity sparkline, lowest-confidence table, most-accessed table. See FRONTEND.md §5 for exact metrics.

**Chart library:** Use shadcn `recharts` wrapper (comes with shadcn). No additional chart dependency needed.

**Acceptance:** Stats page shows all 6 metric sections with real data from `/api/stats`.

---

### Step 7 — System Status

**Files to create:**
- `dashboard/src/pages/Status.jsx`
- `dashboard/src/components/status/SystemStatus.jsx`
- `dashboard/src/components/status/ServiceIndicator.jsx`
- `dashboard/src/api/health.js` — fetch `GET /health`

**What to build:** service health indicators (Graphiti, FalkorDB, PostgreSQL, Quorum MCP, Gateway), operational metrics (PENDING_CONFLICT_CHECK count, last decay run, last audit chain verification, audit log size, version counts by status). See FRONTEND.md §7.

**Acceptance:** Status page shows green indicators for running services. Latency shown for Graphiti.

---

### Step 8 — Pending Decisions Queue

Highest governance value. Replaces `quorum pending` CLI command with an actionable UI.

**Files to create:**
- `dashboard/src/pages/Pending.jsx`
- `dashboard/src/components/pending/DecisionQueue.jsx`
- `dashboard/src/components/pending/DecisionCard.jsx`     ← side-by-side diff, conflict reason
- `dashboard/src/components/pending/ReviewForm.jsx`       ← approve/reject/request_changes
- `dashboard/src/components/pending/ConflictDiff.jsx`
- `dashboard/src/api/pending.js`  — `GET /pg/pending` (existing route)
- `dashboard/src/api/review.js`   — `POST /api/review/:id`

**Constitutional enforcement at UI level:**
- If `decoded.sub === decision.author` → disable Approve and Reject buttons, show "You cannot review your own submissions"
- Note field: `<textarea required minLength={10} />` — Submit button disabled until filled

**Acceptance:** Pending queue loads. Approve/reject with a note transitions the decision. Self-review buttons are disabled. Empty queue shows a "No pending decisions" state.

---

### Step 9 — Knowledge Browser + Search

**Files to create:**
- `dashboard/src/pages/Knowledge.jsx`
- `dashboard/src/components/knowledge/KnowledgeBrowser.jsx`
- `dashboard/src/components/knowledge/KnowledgeRow.jsx`
- `dashboard/src/components/knowledge/KnowledgeDetail.jsx`  ← full node detail + version timeline
- `dashboard/src/components/knowledge/VersionTimeline.jsx`
- `dashboard/src/api/knowledge.js`  — `GET /api/knowledge` with pagination
- `dashboard/src/api/search.js`     — `GET /api/search`

**Install shadcn components needed:** `Table`, `Input`, `Select`, `Badge`, `Dialog`

**Acceptance:** Browse all ACTIVE nodes. Filter by domain, entity_type, tag works. Search box fires semantic search, results display ranked by score. Click a row → full detail panel with version history.

---

### Step 10 — Decaying Knowledge Panel + Bump Button

**Note: only shows meaningful data after confidence decay CronJob (GAP-04) has run for ≥1 week. Build the UI now; demo after GAP-04 is deployed.**

**Files to create:**
- `dashboard/src/components/stats/DecayingKnowledge.jsx`   ← sub-view within Stats tab
- `dashboard/src/components/stats/BumpButton.jsx`          ← role-aware, cooldown-enforced
- `dashboard/src/api/bump.js`   — `POST /api/bump/:topic/:key`

**What to build:**
- Toggle: "All Knowledge" / "Decaying (<0.5)" / "At Risk (<0.3)"
- Each row: topic:key, entity type, confidence bar (green/amber/red), last accessed, author
- BumpButton: fires `POST /api/bump/:topic/:key`, on success → optimistically update confidence + show "Bumped — next available [date]"

**Acceptance:** Bump button fires the endpoint. 429 (cooldown) shows "Already bumped — available [date]". Confidence bar updates optimistically.

---

### Step 11 — Knowledge Graph (Cytoscape.js)

Most complex section. Build last.

**Files to create:**
- `dashboard/src/pages/Graph.jsx`
- `dashboard/src/components/graph/KnowledgeGraph.jsx`     ← Cytoscape.js wrapper
- `dashboard/src/components/graph/NodePanel.jsx`          ← slide-in detail on click
- `dashboard/src/components/graph/GraphControls.jsx`      ← domain filter, layout toggle
- `dashboard/src/api/graph.js`   — `GET /api/graph?domain=X`

**Cytoscape setup:**
```js
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import coseBilkent from 'cytoscape-cose-bilkent'
cytoscape.use(dagre)
cytoscape.use(coseBilkent)
```

**Node styling:** Decision=blue, Pattern=green, Constraint=amber, Runbook=purple, Requirement=grey. Node size = confidence × base_size.

**Edge styling:** SUPERSEDES=dashed arrow, CONFLICTS_WITH=red solid, RELATES_TO=grey, DEPENDS_ON=solid black.

**Scale guard:** if `GET /api/graph` returns 400 (too many nodes, no domain filter), show a domain picker prompt before loading.

**Acceptance:** Graph loads for a specific domain. Click node → NodePanel slides in with full content. CONFLICTS_WITH edge → opens pending decision if unresolved.

---

### Step 12 — Config Editor

**Files to create:**
- `dashboard/src/pages/Config.jsx`
- `dashboard/src/components/config/ConfigEditor.jsx`
- `dashboard/src/components/config/MemberTable.jsx`       ← add/remove, role picker
- `dashboard/src/components/config/DomainSettings.jsx`    ← per-domain conflict threshold slider
- `dashboard/src/components/config/AuthorityWeights.jsx`  ← weights that sum to 1.0
- `dashboard/src/api/config.js`   — `GET /config/:projectId`, `POST /config/validate`, `PUT /config/:projectId`

**Note:** `PUT /config/:projectId` does not yet exist in the Gateway. It needs to be added to `src/gateway/routes/config.js` — this endpoint uploads the new config JSON to S3 then invalidates the cache. **This is a new Gateway route required by this step.**

**Validation UX:** every field change fires `POST /config/validate` (debounced 500ms). Errors shown inline. Save button disabled until valid.

**Acceptance:** Config editor loads current config. Edit a member's role → validation fires → save succeeds → reload confirms change.

---

### Step 13 — Audit Timeline

**Files to create:**
- `dashboard/src/pages/Audit.jsx`
- `dashboard/src/components/audit/AuditTimeline.jsx`
- `dashboard/src/components/audit/AuditEntry.jsx`
- `dashboard/src/api/audit.js`   — `GET /pg/audit` (existing route) with filter params

**What to build:** chronological log, filter by author/operation/topic/date. SHA256 chain indicator. Archived entry indicator (when GAP-05 archival is implemented).

**Acceptance:** Audit timeline loads. Filters narrow results. SHA256 indicator shows "verified" when chain is intact.

---

## File Summary

### Backend — new/modified

| File | Action | Step |
|------|--------|------|
| `scripts/init-db.sql` | Add `bump_log` table | 1 |
| `src/gateway/routes/dashboard.js` | Create — 6 BFF endpoints | 2 |
| `src/gateway/routes/config.js` | Add `PUT /config/:projectId` | 12 |
| `src/gateway/server.js` | Mount `/api` + remove `/bump` mount | 2 |
| `src/gateway/routes/bump.js` | Remove standalone rate limit (inherited) | 2 |

### Frontend — new files

Everything under `dashboard/` — see step-by-step list above. Total: ~35 files.

---

## Dependencies Between Steps

```
Step 1 (schema)  → Step 2 (bump endpoint needs bump_log)
Step 2 (BFF)     → Step 4 (auth), Step 6 (stats), Step 7 (status), Step 8 (review)
Step 3 (scaffold) → Step 4 (auth)
Step 4 (auth)    → Step 5 (layout/nav) → all subsequent steps
Step 6 (stats)   → Step 10 (decaying panel, sub-view of stats)
GAP-04 (CronJob) → Step 10 (demo only — build Step 10 without waiting)
Step 12 (config) → requires new PUT route in gateway (must build before UI)
```

---

## Open Questions (from FRONTEND.md §"Open Questions")

| # | Question | Recommended resolution |
|---|----------|----------------------|
| 1 | ~~Notifications: poll or webhook?~~ | Resolved: browser polling, 60-min default |
| 2 | Multi-project switch without re-auth? | Defer: project_id typed at login; project picker is future enhancement |
| 3 | Graph scale (500+ nodes)? | Return 400 when no domain filter + node count > 500 |
| 4 | Config write path (`PUT /config/:projectId`)? | Implement in Step 12 alongside Config Editor |
| 5 | Notification poll shows count vs specific keys? | Store last-seen decision IDs in localStorage; diff to name specific topic:key pairs in browser notification |

---

## What Is Not In Scope

- GAP-04 confidence decay CronJob (Step 10 depends on it for real data, but it is a separate implementation unit in Wave 3)
- GAP-02 constitutional CI (separate Wave 6 item)
- Webhook/Slack notifications (FRONTEND.md marks this as a future enhancement)
- SKILL.md (Wave 7, intentionally last)
