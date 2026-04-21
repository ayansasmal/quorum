# Quorum Dashboard — Implementation Plan

> Branch: `feat/dashboard`
> Created: 2026-04-19
> Purpose: Step-by-step guide for the new session to implement the Quorum visibility dashboard. Self-contained — no prior conversation context required.

---

## What This Is

A React + Vite dashboard served by Nginx. It talks exclusively to the Quorum Gateway (Express) via JWT-authenticated HTTP. No new backend services — the gateway grows a `dashboard.js` BFF route file. The dashboard lives in `dashboard/` at the repo root (monorepo).

Full design decisions, component structure, and API contracts are in [FRONTEND.md](FRONTEND.md). This file is the sequenced build plan.

---

## Constraints and Non-Negotiables

- **Node 24 LTS** for all Node processes (dashboard build, gateway)
- **No re-authentication on project switch** — single JWT carries all projects as array; project scope via `X-Quorum-Project-Id` header
- **Bump endpoint is `/bump/:topic/:key`** — NOT `/api/bump`. It lives on the existing `src/gateway/routes/bump.js`, mounted at root `/bump` in `server.js`
- **Notification endpoint is `GET /api/notifications`** — returns full array (not just count). Count = `array.length`. Full decision detail fetched in parallel when queue is opened
- **Config editor writes to `PATCH /projects/:id`** — NOT S3. The Wave 2 route already exists in `src/gateway/routes/projects.js`
- **TanStack Table v8** for all tabular data (not AG Grid)
- **shadcn/ui is MIT licensed** — CLI copies source into `dashboard/src/components/ui/`; no runtime npm dependency

---

## Tech Stack

| Layer | Version | Notes |
|-------|---------|-------|
| Node | 24 LTS | `node:24-alpine` in Dockerfile |
| React | 19 | `react@latest` |
| Vite | 6 | `vite@latest` |
| Tailwind CSS | 4 | `@tailwindcss/vite` plugin (no PostCSS config needed) |
| shadcn/ui | latest | `npx shadcn@latest init` — copies source, no npm dep |
| TanStack Query | 5 | `@tanstack/react-query` |
| TanStack Table | 8 | `@tanstack/react-table` |
| Cytoscape.js | 3 | `cytoscape` + `cytoscape-dagre` + `cytoscape-cose-bilkent` |
| React Router | 7 | `react-router-dom` |
| Recharts | 2 | Bar chart, histogram, sparkline for Stats panel |
| Nginx | Alpine | Static file serving + SPA routing |

---

## Repository Structure

```
(repo root)
├── dashboard/                    ← NEW: entire frontend
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── api/                  ← TanStack Query hooks + fetch wrappers
│       ├── components/
│       │   ├── ui/               ← shadcn/ui copied components
│       │   ├── layout/
│       │   ├── graph/
│       │   ├── pending/
│       │   ├── knowledge/
│       │   ├── audit/
│       │   ├── stats/
│       │   ├── config/
│       │   └── status/
│       ├── context/
│       │   └── AuthContext.jsx
│       └── pages/
├── src/gateway/
│   └── routes/
│       └── dashboard.js          ← NEW: BFF routes (stats, notifications, graph, knowledge, review, search)
└── docker-compose.yml            ← ADD: quorum-dashboard service
```

---

## Implementation Waves

### Wave A — Scaffold + Auth (do first, unblocks everything else)

**Goal:** `npm run dev` opens a login page; entering a GitHub token returns a JWT with all projects; sidebar project picker works.

#### A1. Dashboard scaffold

```bash
cd /path/to/repo
mkdir dashboard && cd dashboard
npm create vite@latest . -- --template react
npm install
npm install @tanstack/react-query @tanstack/react-table react-router-dom
npm install -D tailwindcss @tailwindcss/vite
npx shadcn@latest init   # choose: TypeScript=No, Tailwind=Yes, src dir=Yes
```

**vite.config.js:**
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/auth':    { target: 'http://localhost:3001', changeOrigin: true },
      '/api':     { target: 'http://localhost:3001', changeOrigin: true },
      '/bump':    { target: 'http://localhost:3001', changeOrigin: true },
      '/projects':{ target: 'http://localhost:3001', changeOrigin: true },
    }
  }
})
```

The Vite proxy removes CORS issues in dev. In production, Nginx handles routing to gateway.

#### A2. AuthContext

**File: `dashboard/src/context/AuthContext.jsx`**

```jsx
import { createContext, useContext, useState, useCallback } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [jwt, setJwt] = useState(null)
  const [activeProjectId, setActiveProjectId] = useState(null)

  // Decode projects array from JWT payload (no verification — gateway already verified)
  const projects = jwt
    ? JSON.parse(atob(jwt.split('.')[1])).projects ?? []
    : []

  const login = useCallback((token) => {
    setJwt(token)
    // Auto-select first project
    const p = JSON.parse(atob(token.split('.')[1])).projects ?? []
    if (p.length > 0) setActiveProjectId(p[0].id)
  }, [])

  const logout = useCallback(() => { setJwt(null); setActiveProjectId(null) }, [])

  // Headers for every API call
  const authHeaders = jwt ? {
    Authorization: `Bearer ${jwt}`,
    'X-Quorum-Project-Id': activeProjectId ?? '',
  } : {}

  return (
    <AuthContext.Provider value={{ jwt, projects, activeProjectId, setActiveProjectId, login, logout, authHeaders }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
```

#### A3. Login page

**File: `dashboard/src/pages/Login.jsx`**

Form: single input for GitHub token + project slug (optional). On submit:
```js
const res = await fetch('/auth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ github_token: value }),
})
const { token } = await res.json()
login(token)
navigate('/')
```

Show error if response is not ok.

#### A4. App routing

**File: `dashboard/src/App.jsx`**

```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/layout/Layout'
import Login from './pages/Login'
import Stats from './pages/Stats'
import Pending from './pages/Pending'
import Knowledge from './pages/Knowledge'
import Graph from './pages/Graph'
import Audit from './pages/Audit'
import Config from './pages/Config'
import Status from './pages/Status'

function ProtectedRoute({ children }) {
  const { jwt } = useAuth()
  return jwt ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/stats" replace />} />
          <Route path="stats"     element={<Stats />} />
          <Route path="pending"   element={<Pending />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="graph"     element={<Graph />} />
          <Route path="audit"     element={<Audit />} />
          <Route path="config"    element={<Config />} />
          <Route path="status"    element={<Status />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

#### A5. Sidebar with project picker

**File: `dashboard/src/components/layout/Sidebar.jsx`**

- Logo + app name at top
- Navigation links: Stats / Pending (badge with count) / Knowledge / Graph / Audit / Config / Status
- Project picker `<select>` at bottom — lists `projects` from `useAuth()`, sets `setActiveProjectId` on change
- Active project name displayed

The pending badge count comes from `useNotifications()` hook (see Wave B).

#### A6. Gateway: update `/auth/token` to return multi-project JWT

**File: `src/gateway/routes/auth.js`**

Update the token signing logic to:
1. After GitHub identity resolution, query `projects` table for all projects where `members @> '[{"github_username": "<login>"}]'::jsonb`
2. Build `projects` array: `[{ id, slug: name, role, team, base_confidence }]`
3. Include `projects` array in JWT payload instead of single `project`

```js
// Query all projects for this user
const result = await pool.query(
  `SELECT id, name AS slug, members FROM projects
   WHERE status = 'ACTIVE'
     AND members @> $1::jsonb`,
  [JSON.stringify([{ github_username: login }])]
)

const projects = result.rows.map(row => {
  const member = row.members.find(m => m.github_username === login)
  return {
    id: row.id,
    slug: row.slug,
    role: member.role,
    team: member.team ?? 'unknown',
    base_confidence: member.base_confidence ?? 0.7,
  }
})

const payload = { sub: login, projects, iat: now, exp: now + 3600 }
```

**Backward compatibility:** Existing non-dashboard callers that pass a single `project_id` in the request body can still work — the gateway's `projectMiddleware` reads the `X-Quorum-Token` header, not the JWT `project` claim.

---

### Wave B — Gateway BFF Routes

**Goal:** All dashboard API endpoints exist and return real data. No frontend for them yet — test with curl.

**File to create: `src/gateway/routes/dashboard.js`**

All routes are scoped by `X-Quorum-Project-Id` header (read from `req.headers['x-quorum-project-id']`).

#### B1. `GET /api/stats`

```js
// PostgreSQL aggregate query
const stats = await pool.query(`
  SELECT
    topic,
    COUNT(*) FILTER (WHERE status = 'ACTIVE')  AS active_count,
    COUNT(*) FILTER (WHERE status = 'DRAFT')   AS draft_count,
    AVG(confidence) FILTER (WHERE status = 'ACTIVE') AS avg_confidence
  FROM knowledge_versions
  WHERE project_id = $1
  GROUP BY topic
`, [projectId])

// Also query: pending decisions, activity last 30 days, confidence buckets,
// lowest confidence ACTIVE nodes, most accessed nodes
```

Response shape documented in FRONTEND.md § `GET /api/stats`.

#### B2. `GET /api/notifications`

```js
// Returns pending decisions where requesting user is NOT the author
const result = await pool.query(`
  SELECT
    pd.id            AS conflict_id,
    kv.topic,
    kv.key,
    pd.conflict_type AS type,
    kv.author        AS incoming_author,
    EXTRACT(EPOCH FROM (NOW() - pd.created_at)) / 3600 AS age_hours
  FROM pending_decisions pd
  JOIN knowledge_versions kv ON kv.id = pd.incoming_version_id
  WHERE pd.project_id = $1
    AND pd.status = 'PENDING'
    AND kv.author != $2
  ORDER BY pd.created_at ASC
`, [projectId, req.user.sub])
```

#### B3. `GET /api/graph?domain=X`

Queries `knowledge_versions` for ACTIVE nodes and derives edges from `supersedes` JSONB column and `pending_decisions` for CONFLICTS_WITH edges.

```js
// Nodes
const nodes = await pool.query(`
  SELECT id, topic, key, entity_type, confidence, author, content, status, version
  FROM knowledge_versions
  WHERE project_id = $1 AND status IN ('ACTIVE', 'SUPERSEDED')
    AND ($2::text IS NULL OR topic = $2)
`, [projectId, domain ?? null])

// Edges: SUPERSEDES from supersedes.version column
// Edges: CONFLICTS_WITH from pending_decisions (PENDING status)
```

Returns Cytoscape.js-compatible `{ nodes: [...], edges: [...] }` format.

#### B4. `GET /api/knowledge`

Paginated query with optional domain/tag/entity_type filters:

```js
const { domain, tag, entity_type, page = 1, limit = 20 } = req.query
// WHERE project_id = $1 AND status = 'ACTIVE'
// AND (domain IS NULL OR topic = domain)
// AND (entity_type IS NULL OR entity_type = ...)
// AND (tag IS NULL OR tags @> ARRAY[$tag])
// LIMIT $limit OFFSET ($page - 1) * $limit
```

#### B5. `POST /api/review/:conflictId`

Orchestration route — single PostgreSQL transaction:
1. Validate `req.body.note` length ≥ 10 chars
2. Fetch conflict from `pending_decisions` — verify `req.user.sub !== conflict.author` (rule 4)
3. If `approve`: DRAFT → ACTIVE, previous ACTIVE → SUPERSEDED (atomic)
4. If `reject`: DRAFT → REJECTED
5. If `request_changes`: note appended, stays PENDING
6. Write audit entry in all cases

#### B6. `GET /api/search?q=X&domain=Y&limit=10`

Proxy to Graphiti `search_nodes`:

```js
import { searchNodes } from '../../graph/client.js'
const results = await searchNodes(req.query.q, {
  groupId: projectId,
  limit: parseInt(req.query.limit ?? '10'),
})
// Map results to { topic, key, entity_type, summary, confidence, score, author, updated_at }
```

#### B7. Wire routes in `src/gateway/server.js`

```js
import dashboardRoutes from './routes/dashboard.js'
// ... after existing routes:
app.use('/api', jwtMiddleware, dashboardRoutes)
```

The `/bump` route is already wired as `app.use('/bump', apiLimit, bumpRoutes)` — no change needed there.

---

### Wave C — Stats Panel + System Status (quick wins, pure PostgreSQL)

**Goal:** First two real dashboard pages working.

#### C1. Stats page

**File: `dashboard/src/api/stats.js`**

```js
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../context/AuthContext'

export function useStats() {
  const { authHeaders } = useAuth()
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => fetch('/api/stats', { headers: authHeaders }).then(r => r.json()),
    refetchInterval: 5 * 60 * 1000, // 5 min
  })
}
```

**File: `dashboard/src/pages/Stats.jsx`**

Layout:
- Row 1: 4 metric cards (total active, pending decisions, avg confidence, domains)
- Row 2: Domain bar chart (Recharts `BarChart`) + Confidence histogram
- Row 3: Decaying Knowledge table (TanStack Table — see Wave E)
- Row 4: Most accessed / Lowest confidence tables

#### C2. System Status page

**File: `dashboard/src/api/health.js`**

```js
export function useHealth() {
  const { authHeaders } = useAuth()
  return useQuery({
    queryKey: ['health'],
    queryFn: () => fetch('/health', { headers: authHeaders }).then(r => r.json()),
    refetchInterval: 60 * 1000, // 1 min
  })
}
```

**File: `dashboard/src/pages/Status.jsx`**

- Service indicator cards (Graphiti / FalkorDB / PostgreSQL / Gateway)
- Operational stats from `/api/stats`: `PENDING_CONFLICT_CHECK` count, last decay run, knowledge version counts by status

---

### Wave D — Pending Decisions Queue (highest governance value)

**Goal:** Reviewers can approve/reject conflicts without opening Claude.

#### D1. Notification polling hook

**File: `dashboard/src/api/notifications.js`**

```js
export function useNotifications() {
  const { authHeaders } = useAuth()
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetch('/api/notifications', { headers: authHeaders }).then(r => r.json()),
    refetchInterval: pollInterval * 60 * 1000, // from config, default 60 min
  })
}
```

Browser notification logic — call once on app mount:
```js
// In Layout.jsx or a useEffect in App.jsx
const { data: notifications } = useNotifications()
const prevIdsRef = useRef(new Set())

useEffect(() => {
  if (!notifications) return
  const currentIds = new Set(notifications.map(n => n.conflict_id))
  const newItems = notifications.filter(n => !prevIdsRef.current.has(n.conflict_id))

  if (newItems.length > 0 && Notification.permission === 'granted') {
    newItems.forEach(item => {
      new Notification('Quorum — review needed', {
        body: `${item.topic}:${item.key} — incoming from @${item.incoming_author}`,
        tag: item.conflict_id,
      })
    })
  }
  prevIdsRef.current = currentIds
}, [notifications])
```

#### D2. Pending queue page

**File: `dashboard/src/pages/Pending.jsx`**

Uses `useNotifications()` for the list. For each item, shows a `<DecisionCard>`.

`<DecisionCard>` (read from `pending_decisions` + `knowledge_versions` via a detail endpoint):
- `topic:key` header
- Conflict reason text
- Side-by-side diff: existing content (left) vs incoming content (right) — use a simple two-column layout with `<pre>` tags, not a full diff library
- Similarity score badge
- Age indicator (amber if > 24h, red if > 48h)
- Enrichment panel (lazy — call `GET /pg/pending/:id` which returns enrichment, generating it if null per COST-03)

**Review form** (`<ReviewForm>`):
```jsx
// action: 'approve' | 'reject' | 'request_changes'
const submit = async () => {
  await fetch(`/api/review/${conflictId}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, note }),
  })
  queryClient.invalidateQueries({ queryKey: ['notifications'] })
}
```

Note field: `<textarea>` with character counter. Submit disabled until length ≥ 10. Self-approval: if `jwt.sub === decision.author`, action buttons are disabled with tooltip "You cannot review your own entries."

---

### Wave E — Decaying Knowledge + Bump Button

**Goal:** Engineers can see what knowledge is aging and endorse it with one click.

**Prerequisite:** Confidence decay CronJob (GAP-04) must be deployed and have run at least once. Build the UI regardless — it just shows empty state until data exists.

#### E1. Decaying Knowledge table

**File: `dashboard/src/components/stats/DecayingKnowledge.jsx`**

Uses TanStack Table v8:

```jsx
import { useReactTable, getCoreRowModel, getSortedRowModel, flexRender } from '@tanstack/react-table'

const columns = [
  { accessorKey: 'topic',              header: 'Topic' },
  { accessorKey: 'key',                header: 'Key' },
  { accessorKey: 'entity_type',        header: 'Type' },
  { accessorKey: 'confidence',         header: 'Confidence',
    cell: ({ getValue }) => <ConfidenceBar value={getValue()} /> },
  { accessorKey: 'starting_confidence',header: 'Started at' },
  { accessorKey: 'last_accessed',      header: 'Last accessed' },
  { id: 'bump',                        header: '',
    cell: ({ row }) => <BumpButton topic={row.original.topic} nodeKey={row.original.key} /> },
]
```

Data source: `GET /api/stats` returns `lowest_confidence` array. Filter toggle: "All" / "Decaying (<0.5)" / "At Risk (<0.3)".

#### E2. Bump button

**File: `dashboard/src/components/stats/BumpButton.jsx`**

```jsx
export function BumpButton({ topic, nodeKey }) {
  const { authHeaders } = useAuth()
  const queryClient = useQueryClient()
  const [cooldownUntil, setCooldownUntil] = useState(null)

  const bump = async () => {
    const res = await fetch(`/bump/${topic}/${nodeKey}`, {
      method: 'POST',
      headers: authHeaders,
    })
    if (res.status === 429) {
      const { next_bump_allowed } = await res.json()
      setCooldownUntil(new Date(next_bump_allowed))
      return
    }
    const { confidence, next_bump_allowed } = await res.json()
    setCooldownUntil(new Date(next_bump_allowed))
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const disabled = cooldownUntil && new Date() < cooldownUntil

  return (
    <button onClick={bump} disabled={disabled}
      className={disabled ? 'text-gray-400 cursor-not-allowed' : 'text-blue-600 hover:underline'}>
      {disabled
        ? `Next: ${cooldownUntil.toLocaleDateString()}`
        : 'Bump'}
    </button>
  )
}
```

**`<ConfidenceBar>` component:**
```jsx
function ConfidenceBar({ value }) {
  const color = value > 0.7 ? 'bg-green-500' : value > 0.4 ? 'bg-amber-400' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 bg-gray-200 rounded h-2">
        <div className={`${color} h-2 rounded`} style={{ width: `${value * 100}%` }} />
      </div>
      <span className="text-sm">{(value * 100).toFixed(0)}%</span>
    </div>
  )
}
```

---

### Wave F — Knowledge Browser + Search

**Goal:** Engineers can browse and search all knowledge without using Claude.

#### F1. Knowledge browser page

**File: `dashboard/src/pages/Knowledge.jsx`**

TanStack Table with server-side pagination:
- URL params: `?domain=auth&page=1&limit=20`
- Sort: confidence (default desc), recency, author
- Filter row: domain dropdown + entity type dropdown + free-text tag filter
- Each row links to `<KnowledgeDetail>` slide-in panel

**`<VersionTimeline>` component:**
```jsx
// Reads from GET /pg/versions/:topic/:key?history=true
// Renders vertical timeline: v3 (ACTIVE) → v2 (SUPERSEDED) → v1 (SUPERSEDED)
// Each node: version number, author, date, triggered_by, reason
```

#### F2. Search

**File: `dashboard/src/api/search.js`**

```js
export function useSearch(query, domain) {
  const { authHeaders } = useAuth()
  return useQuery({
    queryKey: ['search', query, domain],
    queryFn: () => fetch(`/api/search?q=${encodeURIComponent(query)}&domain=${domain ?? ''}`, {
      headers: authHeaders,
    }).then(r => r.json()),
    enabled: query.length > 2,
  })
}
```

Search bar in `<Header>` — debounced 300ms. Results shown inline (popover) or navigate to `/knowledge?q=<query>`.

---

### Wave G — Knowledge Graph (Cytoscape.js)

**Goal:** Visual graph of the knowledge base. Most complex piece — do last.

**File: `dashboard/src/components/graph/KnowledgeGraph.jsx`**

```jsx
import CytoscapeComponent from 'react-cytoscapejs'
import coseBilkent from 'cytoscape-cose-bilkent'
import dagre from 'cytoscape-dagre'
import Cytoscape from 'cytoscape'

Cytoscape.use(coseBilkent)
Cytoscape.use(dagre)

const NODE_COLORS = {
  Decision:    '#3b82f6',  // blue
  Pattern:     '#22c55e',  // green
  Constraint:  '#f59e0b',  // amber
  Runbook:     '#a855f7',  // purple
  Requirement: '#6b7280',  // grey
}

const stylesheet = [
  { selector: 'node', style: {
    label: 'data(key)',
    backgroundColor: (ele) => NODE_COLORS[ele.data('entity_type')] ?? '#6b7280',
    width: (ele) => 20 + ele.data('confidence') * 30,
    height: (ele) => 20 + ele.data('confidence') * 30,
  }},
  { selector: 'edge[type="SUPERSEDES"]',    style: { lineStyle: 'dashed', lineColor: '#94a3b8' }},
  { selector: 'edge[type="CONFLICTS_WITH"]',style: { lineColor: '#ef4444', width: 2 }},
  { selector: 'edge[type="RELATES_TO"]',    style: { lineColor: '#cbd5e1' }},
  { selector: 'edge[type="DEPENDS_ON"]',    style: { lineColor: '#64748b', targetArrowShape: 'triangle' }},
]
```

Layout switching: SUPERSEDES-only subgraph → `dagre` (top-to-bottom). Full graph → `cose-bilkent`.

**Performance:** At > 300 nodes, hide SUPERSEDED nodes by default. Domain filter reduces node count significantly. Server-side filtering via `?domain=X` param.

---

### Wave H — Config Editor

**Goal:** Project config editable without touching the database directly.

**File: `dashboard/src/pages/Config.jsx`**

Sections:
1. **Members table** — TanStack Table, inline editing of role/team/base_confidence. Add/remove rows. Validation: at least one `principal_architect` must remain.
2. **Domain settings** — add/remove domains, confidence threshold slider per domain (0.70–0.95).
3. **Authority weights** — four sliders (confidence/recency/access/role) with live sum indicator (must equal 1.0). Disable Save if sum ≠ 1.0.
4. **Governance settings** — authority threshold, DRAFT alert age.

**Save flow:**
```js
const save = async () => {
  // 1. POST /config/validate — inline validation feedback
  const validation = await fetch('/config/validate', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(editedConfig),
  })
  if (!validation.ok) { setErrors(await validation.json()); return }

  // 2. PATCH /projects/:id
  const result = await fetch(`/projects/${activeProjectId}`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      members:    editedConfig.members,
      domains:    editedConfig.domains,
      governance: editedConfig.thresholds,
      config_version: currentConfigVersion,  // optimistic lock
    }),
  })
  if (result.status === 409) { setError('Config was updated by someone else — refresh and retry') }
}
```

---

### Wave I — Audit Timeline (cosmetic, do last)

**File: `dashboard/src/pages/Audit.jsx`**

Paginated query from `GET /pg/audit` (existing route). Chronological list, newest first. Filter by: author, operation, topic, date range. Each entry shows SHA256 chain status badge (verified / tampered). Simple `<AuditEntry>` card component.

---

## Docker Setup

#### `dashboard/Dockerfile`

```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

#### `dashboard/nginx.conf`

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

#### Add to `docker-compose.yml`

```yaml
  quorum-dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    ports:
      - "3002:80"        # :3002 → :3000 FalkorDB UI, :3001 gateway
    environment:
      - VITE_GATEWAY_URL=http://localhost:3001
    depends_on:
      - quorum-gateway
    networks:
      - quorum-network
```

The Nginx container serves the pre-built static files. In dev, use `npm run dev` in `dashboard/` — Vite proxy handles gateway calls at `localhost:3001`.

---

## Gateway Changes Summary

Files to modify in `src/gateway/`:

| File | Change |
|------|--------|
| `routes/auth.js` | Return multi-project JWT (`projects` array) |
| `routes/dashboard.js` | NEW — 6 BFF routes |
| `server.js` | `app.use('/api', jwtMiddleware, dashboardRoutes)` |

Existing files unchanged:
- `routes/bump.js` — bump endpoint already at `/bump` (correct path)
- `routes/projects.js` — `PATCH /projects/:id` already implemented (Wave 2)
- `routes/pg.js` — existing pending/versions/audit routes still used by dashboard

---

## Test Coverage

No new unit tests required for the frontend (browser code — unit tests are low value). The new gateway BFF routes should have integration tests:

- `tests/tools/dashboard.test.js` — mock `pg.query`, test that `/api/notifications` filters out author's own decisions (constitutional rule 4 enforcement)
- Auth route test: verify JWT `projects` array is populated from DB query

---

## Start Order (cold start)

1. `docker-compose up falkordb postgresql graphiti` — wait for health checks
2. `docker-compose up quorum-gateway` — wait for "Listening on port 3001"
3. `cd dashboard && npm run dev` — dashboard at `http://localhost:5173`
4. Open browser → `http://localhost:5173` → login with GitHub token

---

## Open Question (still unresolved)

**Graph scale:** At ~500+ nodes, Cytoscape.js `cose-bilkent` layout becomes slow. Mitigation: render only the active domain by default, hide SUPERSEDED nodes. If this is still slow in testing, add server-side pagination for the graph endpoint and virtualise node rendering. Address this when testing with real data.
