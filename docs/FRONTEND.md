# Quorum — Frontend Dashboard Design

> Created: 2026-04-19
> Status: Implemented — Wave 4 complete (2026-04-21)
> Purpose: Full reference for the Quorum visibility dashboard implementation

---

## Why This Exists

Quorum's core problem (documented in `ANALYSIS.md`) is that it is a well-built governance engine with no delivery mechanism. The constitutional layer, audit chain, conflict detection, and versioning are all solid — but none of it surfaces to anyone proactively.

The dashboard addresses three of the weakest bars in the capability chart simultaneously:

```
Before dashboard:
  Visibility / dashboard       ░░░░░░░░░░░░░░  Not started
  Platform team UX             ██░░░░░░░░░░░░  Functional but painful
  Governance model             ██████████░░░░  Pull-based, review queue invisible

After dashboard:
  Visibility / dashboard       ██████████████  Complete
  Platform team UX             ████████████░░  Config editor + system status
  Governance model             ████████████░░  Review queue actionable without Claude
```

**What the dashboard does not fix:**
- Self-evolution loop point 1: `reflect()` still requires SKILL.md deployment
- Notification system: partially addressed via frontend polling (see below) — full push requires a future webhook/Slack integration
- Authority model scoring: config UI makes weights configurable, but the scoring algorithm still needs role/seniority signals

---

## Notification Strategy — Frontend Polling

Rather than building a backend webhook or Slack integration, the dashboard implements **browser-native notifications via periodic polling**. This is sufficient for the primary use case and requires zero new backend infrastructure.

**How it works:**

```
1. On dashboard load → request browser notification permission
   (Notification.requestPermission() — one-time prompt)

2. Background poll every N minutes (configurable, default: 60):
   GET /api/notifications → returns array of pending items

3. If array.length > last known count → fire browser notification per new item:
   "New conflict for auth:token-strategy — incoming from @ayan (2h ago)"

4. Badge on Pending tab in sidebar = array.length (live count)

5. Click notification → opens dashboard, navigates to Pending queue
   (specific conflict pre-selected if conflict_id in notification click data)
```

**Notification endpoint contract:**
```
GET /api/notifications

Response: array — count is array.length
[
  {
    "conflict_id": "cfl_abc123",
    "topic": "auth",
    "key": "token-strategy",
    "type": "semantic_conflict",
    "incoming_author": "ayan",
    "age_hours": 2.5
  },
  ...
]
```

Client calls `GET /api/notifications` on poll tick. If array is longer than the cached version, show one browser notification per new item (diff by conflict_id). Full decision details are fetched in parallel when the Pending queue is opened: `Promise.all(newItems.map(item => fetchDecisionDetail(item.conflict_id)))`.

**Why this works for Quorum's use case:**
- Governance decisions are not time-critical at the minute level — 1 hour is acceptable
- Browser notifications fire even when the tab is minimised or in the background
- For an internal engineering tool, "dashboard pinned as a browser tab" is a reasonable baseline assumption for reviewers
- Poll endpoint (`GET /api/stats`) is a cheap single PostgreSQL aggregate query — negligible server impact even at 15-minute intervals

**Configurable interval:** exposed in the config editor as `dashboard.notification_poll_minutes` (options: 15 / 30 / 60 / 120). Default: 60.

**Honest residual gap:** If the reviewer closes their browser entirely, no notification reaches them. A webhook/Slack integration would close this — but that is a future enhancement, not a blocker for v1.

**Updated notification bar with this approach:**
```
Notification system  ████████░░░░░░  Browser polling covers open-tab scenario
                                      Remaining gap: reviewer browser is closed
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│           Quorum Dashboard  (React + Vite)          │
│                                                      │
│  Graph view    Pending queue    Domain browser       │
│  (Cytoscape.js) (approve/reject) (search, filters)  │
│                                                      │
│  Stats panel   Audit timeline   Config editor        │
│  (confidence,  (activity,       (members, domains,   │
│   domains)      versions)        system status)      │
│                                                      │
│  Served by: Nginx container                          │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS + JWT (ES256)
┌──────────────────────▼──────────────────────────────┐
│        Quorum Gateway  (Express — existing + BFF)   │
│                                                      │
│  EXISTING ROUTES:           NEW BFF ROUTES:          │
│  POST /auth/token           GET  /api/stats          │
│  GET  /.well-known/jwks     GET  /api/notifications  │
│  POST /graphiti/*           GET  /api/graph          │
│  GET  /pg/versions/*        GET  /api/knowledge      │
│  GET  /pg/pending           POST /api/review/:id     │
│  PATCH /pg/pending/:id      GET  /api/search         │
│  GET  /pg/audit             POST /bump/:topic/:key   │
│  GET  /config/:projectId    PATCH /projects/:id      │
│  POST /config/validate      (config editor write)    │
│  GET  /health                                        │
└──────────┬───────────────────────────────────────────┘
           │
    ┌──────┴────────────────┐
    │                       │
 FalkorDB              PostgreSQL
 (via Graphiti          (knowledge_versions,
  sidecar)              pending_decisions,
                         audit_log)
```

### Key architectural decisions

**Separate frontend service, not embedded in Gateway.**
The Gateway stays a pure API. The frontend is a standalone React (Vite) app served by Nginx. This separation means:
- Frontend can be deployed independently (no Gateway restart needed)
- Nginx handles caching, compression, and SPA routing cleanly
- Gateway stays stateless and focused on API concerns

**Cytoscape.js for graph visualization.**
Chosen over vis-network and Sigma.js because:
- Best layout algorithms for DAGs — the SUPERSEDES chain is a directed acyclic graph
- Mature ecosystem, extensive documentation
- Handles hundreds of nodes without performance issues
- Supports custom styling for node types (Decision, Pattern, Constraint, etc.)

**JWT stored in memory, not localStorage.**
The auth token is kept in React state/context only. On page refresh, user re-authenticates via GitHub token. This avoids XSS token theft — acceptable UX trade-off for an internal engineering tool.

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Runtime | Node.js 24 LTS | LTS stability; matched to gateway Node version |
| Framework | React 19 + Vite | Fast dev, small bundle, no SSR needed for internal tool |
| Graph viz | Cytoscape.js | Best DAG layout, handles SUPERSEDES chains |
| Tables | TanStack Table v8 | Headless (~14KB), sort/filter/pagination, no vendor lock-in |
| Data fetching | TanStack Query | Cache + background refetch without complexity |
| UI components | shadcn/ui (MIT) + Tailwind v4 | CLI copies source into project — no npm dep, full control |
| HTTP client | Native fetch + TanStack Query | No extra library needed |
| Serving | Nginx (Alpine) | Static file serving + SPA routing |
| Build | Vite | Fast HMR in dev, optimised bundle in prod |

---

## Authentication Flow

**Single JWT for all projects.** One GitHub token authentication returns a JWT carrying all projects the user is a member of. Per-request project scope is resolved via `X-Quorum-Project-Id` header — no re-authentication when switching projects.

```
1. User opens dashboard → sees login screen
2. Enters GitHub personal access token (+ optional default project slug)
3. Frontend: POST /auth/token { github_token }
4. Gateway: verifies token with GitHub API → queries all projects where member
5. Gateway: signs ES256 JWT carrying full projects array
6. Frontend: stores JWT in React context (memory only)
7. All subsequent API calls:
     Authorization: Bearer <JWT>
     X-Quorum-Project-Id: <selected-project-id>   ← set by project picker
8. JWT expiry (1 hour): re-auth prompt appears
9. Project switch: update X-Quorum-Project-Id header — no new JWT needed
```

JWT claims available to the frontend (decoded client-side):
```json
{
  "sub": "github-username",
  "projects": [
    { "id": "proj_abc", "slug": "platform-core", "role": "principal_architect", "team": "platform", "base_confidence": 0.85 },
    { "id": "proj_xyz", "slug": "payments-api",  "role": "engineer",            "team": "payments", "base_confidence": 0.70 }
  ],
  "iat": 1714000000,
  "exp": 1714003600
}
```

**Project picker:** Sidebar dropdown lists all projects from JWT `projects` array. Selection sets the active `X-Quorum-Project-Id` header in `AuthContext` — all API hooks read it from context. No page reload required.

---

## Dashboard Sections

### 1. Knowledge Graph (primary view)

The centrepiece. Visualises the entire knowledge graph for the active project/domain.

**What it shows:**
- Nodes: each ACTIVE knowledge entry — coloured by entity type (Decision=blue, Pattern=green, Constraint=amber, Runbook=purple, Requirement=grey)
- Node size: scaled by confidence score
- Edges: SUPERSEDES (dashed arrow), CONFLICTS_WITH (red), RELATES_TO (grey), DEPENDS_ON (solid arrow)
- Faded nodes: SUPERSEDED versions (togglable)

**Interactions:**
- Click node → slide-in panel with full content, version history, author, confidence, tags
- Click SUPERSEDES edge → shows the version transition reason
- Click CONFLICTS_WITH edge → opens the pending decision if unresolved
- Filter by domain (dropdown) — redraws graph for selected domain only
- Search highlights matching nodes in place

**Cytoscape.js layout:** `dagre` for SUPERSEDES chains (top-to-bottom version lineage), `cose-bilkent` for the full graph (force-directed, handles clusters well).

---

### 2. Pending Decisions Queue

The reviewer workflow. Replaces "asking Claude for `pending()`" with an actionable UI.

**What it shows:**
- List of all pending decisions, sorted by age (oldest first)
- Each card shows: topic:key, conflict reason, existing vs incoming content side-by-side, similarity score, possible_split signal, staleness warning (if ACTIVE version has advanced since DRAFT was created)
- Enrichment panel (generated lazily on first open — see COST-03)

**Actions per decision:**
- **Approve** → `POST /api/review/:id { action: "approve", note: "..." }` — note required
- **Reject** → `POST /api/review/:id { action: "reject", note: "..." }` — note required
- **Request changes** → `POST /api/review/:id { action: "request_changes", note: "..." }` — stays as DRAFT, note sent back
- **Split** → UI prompts for two new topic:keys with scoped content → creates two separate entries
- **Merge** → UI opens editor for a combined entry → single superseding write

**Constitutional enforcement at UI level:**
- Reviewer cannot approve their own DRAFTs (UI disables action if `req.user.sub === draft.author`)
- Note field is required — submit button disabled until non-empty

---

### 3. Domain Browser + Search

Paginated knowledge browser. For engineers who want to read what Quorum knows.

**What it shows:**
- All ACTIVE knowledge nodes, filterable by domain, entity type, tag, author
- Sorted by confidence (default) or recency
- Each row: topic:key, entity type, confidence score, last updated, author, tags
- Click → full detail view with version history timeline

**Search:**
- Calls `GET /api/search?q=<query>&domain=<domain>` → proxies to Graphiti semantic search
- Results ranked by relevance, shown with confidence and domain
- Works across all entity types simultaneously

---

### 4. Audit Timeline

For compliance, debugging, and curiosity.

**What it shows:**
- Chronological log of all operations (remember, recall, search, forget, review, reflect)
- Each entry: timestamp, operation, author, topic:key, triggered_by, version impact
- SHA256 chain status indicator (verified / tamper-detected)
- Filter by author, operation type, topic, date range

**Archival indicator:**
- Entries marked as archived show a cloud icon with S3 key (when GAP-05 archival is implemented)
- Entries < 90 days are live; older entries fetched from S3 on demand

---

### 5. Stats Panel

High-level health of the knowledge graph. Answers "what does Quorum know and how healthy is it?"

**Metrics shown:**
- Total active knowledge nodes (by domain — bar chart)
- Confidence distribution (histogram: 0-0.3 / 0.3-0.6 / 0.6-0.8 / 0.8-1.0)
- Pending decisions count + average age (how long decisions sit unreviewed)
- Knowledge added per week (activity sparkline)
- Lowest confidence nodes (table — candidates for `forget()` or refresh)
- Most accessed nodes (table — high-value knowledge)

#### 5a. Decaying Knowledge Panel

Surfaces knowledge that is losing confidence over time, so engineers can actively endorse (bump) it before it decays to the floor.

**What it shows:**
- All ACTIVE nodes sorted by confidence ascending (lowest first)
- Each row: `topic:key`, entity type, current confidence, starting confidence, decay since last access, last accessed date, author
- Visual confidence bar: green (>0.7) / amber (0.4–0.7) / red (<0.4)
- **Bump button** per row — visible only when the current engineer has not bumped this node in the last 7 days (cooldown enforced server-side)

**Bump mechanic:**

```
POST /bump/:topic/:key

Server-side:
  1. Resolve author role from JWT
  2. Enforce cooldown: reject if bump_log has entry from this author+node within 7 days
  3. Compute delta = 0.05 × role_weight
     role_weight:
       engineer          → 0.50  (delta: +0.025)
       senior_engineer   → 0.70  (delta: +0.035)
       architect         → 0.85  (delta: +0.042)
       principal_architect → 1.00 (delta: +0.050)
  4. new_confidence = Math.min(starting_confidence, current_confidence + delta)
  5. Reset last_accessed_at = NOW()  ← stops decay clock
  6. Write audit entry: triggered_by = "bump", author, role, delta applied
  7. Log bump to bump_log (author, topic, key, bumped_at)

Response: { confidence: new_confidence, clock_reset: true, next_bump_allowed: ISO8601 }
```

**Why role-weighted:** A principal architect endorsing knowledge carries more signal than an engineer bumping their own entry. The weight matches GAP-18's role scoring model — same role tiers, same relative weights — so bumps are consistent with authority calculations.

**Why clock reset always:** Even if the role delta is small (engineer: +0.025), the clock reset matters more than the delta. It stops `-0.005/week` from accumulating. Delta is a bonus; clock reset is the primary mechanic.

**Floor protection:** Knowledge cannot be bumped above `starting_confidence`. A node written at confidence 0.50 cannot be bumped to 0.75 — that would misrepresent the author's original signal.

**Cooldown rationale:** Without a per-author cooldown, an engineer could bump their own knowledge weekly to prevent any decay, defeating the purpose of the decay model.

**Dashboard placement:**
- Decaying Knowledge is a sub-view within the Stats Panel tab
- Toggle button: "All Knowledge" / "Decaying (<0.5)" / "At Risk (<0.3)"
- Engineers can filter by domain to focus on what they own
- After a successful bump: row confidence bar updates optimistically, Bump button shows "Bumped — next available [date]"

---

### 6. Config Editor

Replaces "write JSON, upload to S3 manually, wait for poll cycle, hope it worked."

**What it shows:**
- Current active config (fetched from `GET /config/:projectId`)
- Schema version indicator
- Last updated timestamp + who updated it

**Editable sections:**
- **Members** — add/remove engineers, assign role (engineer / tech_lead / architect / principal_architect) and team, set base_confidence
- **Domains** — add/remove domain namespaces, set per-domain conflict threshold (slider: 0.70–0.95)
- **Authority weights** — sliders for confidence / recency / access_frequency weights (must sum to 1.0)
- **Governance settings** — QUORUM_AUTHORITY_THRESHOLD, DRAFT alert max age

**Validation:**
- Inline validation on every change via `POST /config/validate`
- Errors shown inline (member missing github_username, weights don't sum to 1, etc.)
- **Save button** — only enabled when config is valid
- On save: calls `PATCH /projects/:id` with the updated config body — gateway writes directly to the `projects` table. No S3 upload, no poll cycle latency, no cache invalidation step needed. PostgreSQL is the authoritative config store; the optimistic lock (`config_version`) prevents concurrent editor overwrites.

**Why this is important:** Role and seniority signals for the authority model become configurable here — no code change needed to update the org hierarchy. The `PATCH /projects/:id` route already exists from Wave 2, including the PA-guard (last principal architect cannot be removed) and `config_version` double-check locking.

---

### 7. System Status

Operational health at a glance. Surfaces the gaps identified in `ANALYSIS.md`.

**Services shown:**
| Service | Check | Healthy indicator |
|---------|-------|-------------------|
| Graphiti | `/health` ping result | Green / latency ms |
| FalkorDB | Graphiti health response | Green / node count |
| PostgreSQL | `/health` ping result | Green / connection pool |
| Quorum MCP | Self-reported | Green / version |
| Gateway | This page loaded | Always green if visible |

**Operational indicators:**
- `PENDING_CONFLICT_CHECK` count — how many writes are waiting for Graphiti re-check (non-zero = Graphiti was recently down)
- Last confidence decay run timestamp (non-recent = decay job not running)
- Last audit chain verification timestamp
- Audit log size (row count + estimated storage)
- Knowledge versions count (total, by status: ACTIVE / SUPERSEDED / DRAFT / DEPRECATED)

---

## New Gateway BFF Routes

Six new routes added to the existing Express app (`src/gateway/routes/dashboard.js` — new file), plus one new route on the existing bump router.

All routes require JWT (`Authorization: Bearer <JWT>`) and are project-scoped via `X-Quorum-Project-Id` header.

**Note on `/bump`:** The bump endpoint is mounted at `/bump` on the existing gateway (not under `/api`), consistent with how other resource routes (`/pg`, `/graphiti`, `/config`) are mounted at the root level. It is implemented in the existing `src/gateway/routes/bump.js` file — not a new BFF route.

### `GET /api/stats`

Aggregated dashboard metrics. Single query to PostgreSQL.

```
Response:
{
  domains: [{ name, active_count, draft_count, avg_confidence }],
  pending: { total, avg_age_hours, oldest_age_hours },
  activity: [{ date, operation_count }],  // last 30 days
  confidence: { high: N, medium: N, low: N },  // >0.7, 0.4-0.7, <0.4
  lowest_confidence: [{ topic, key, confidence, last_accessed }],
  most_accessed: [{ topic, key, access_count, confidence }]
}
```

### `GET /api/notifications`

Pending conflicts for the current user's review. Used by the notification polling loop.

```
Response: array — count is array.length
[
  {
    "conflict_id": "cfl_abc123",
    "topic": "auth",
    "key": "token-strategy",
    "type": "semantic_conflict",
    "incoming_author": "ayan",
    "age_hours": 2.5
  }
]
```

Returns only decisions where the requesting user is NOT the author (constitutional rule — self-approval blocked). Frontend diffs against cached `conflict_id` set to detect new items between polls.

### `GET /api/graph?domain=X`

Knowledge graph in Cytoscape.js format. Queries PostgreSQL for nodes + edges.

```
Response:
{
  nodes: [
    { data: { id, topic, key, entity_type, confidence, author, summary, status } }
  ],
  edges: [
    { data: { id, source, target, type } }  // type: SUPERSEDES | CONFLICTS_WITH | RELATES_TO
  ]
}
```

Node IDs are `topic:key:version`. Edge types map directly to Quorum's `QuorumEdgeTypes`.

### `GET /api/knowledge?domain=X&tag=Y&entity_type=Z&page=N&limit=20`

Paginated knowledge browser.

```
Response:
{
  items: [{ topic, key, entity_type, confidence, author, tags, updated_at, version }],
  total: N,
  page: N,
  pages: N
}
```

### `POST /bump/:topic/:key`

Endorse a knowledge node to restore confidence and reset the decay clock.

```
Request: JWT required (role resolved server-side)

Server-side steps:
  1. Resolve role from JWT subject → config.members[sub].role
  2. Check bump_log: reject with 429 if bumped within 7 days (per author+node)
  3. Compute delta = 0.05 × role_weight (engineer=0.50, senior=0.70, architect=0.85, principal=1.00)
  4. UPDATE knowledge_versions SET
       confidence = LEAST(starting_confidence, confidence + delta),
       last_accessed_at = NOW()
     WHERE topic=$1 AND key=$2 AND status='ACTIVE'
  5. INSERT INTO bump_log (author, topic, key, bumped_at, role, delta_applied)
  6. Write audit entry (triggered_by = 'bump')

Response: { confidence: 0.62, delta_applied: 0.035, clock_reset: true, next_bump_allowed: "2026-04-26T..." }
```

### `POST /api/review/:conflictId`

**The orchestration endpoint.** Performs the full review flow atomically.

```
Request body:
{
  action: "approve" | "reject" | "request_changes",
  note: string  // required, min 10 chars
}

Server-side steps (single pg transaction):
  1. Validate: reviewer !== author (constitutional rule 4)
  2. If approve:
     a. PATCH pending_decisions: status → RESOLVED, resolution → "approved"
     b. PATCH knowledge_versions: status DRAFT → ACTIVE (new version)
     c. PATCH previous ACTIVE version: status → SUPERSEDED
     d. Write audit entry: triggered_by = "review_approved"
  3. If reject:
     a. PATCH pending_decisions: status → RESOLVED, resolution → "rejected"
     b. PATCH knowledge_versions: status DRAFT → REJECTED
     c. Write audit entry: triggered_by = "review_rejected"
  4. If request_changes:
     a. PATCH pending_decisions: add note to stale_warning field, stays PENDING
     b. Write audit entry: triggered_by = "review_changes_requested"
```

### `GET /api/search?q=X&domain=Y&limit=10`

Semantic search proxy — calls Graphiti's `search_nodes` and formats results.

```
Response:
{
  results: [
    { topic, key, entity_type, summary, confidence, score, author, updated_at }
  ]
}
```

---

## docker-compose Additions

```yaml
# Add to existing docker-compose.yml

  quorum-dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    ports:
      - "3002:80"        # dashboard on :3002 (gateway owns :3001, FalkorDB browser owns :3000)
    depends_on:
      gateway:
        condition: service_healthy
    # No VITE_GATEWAY_URL needed — nginx.conf proxies /auth, /api, /config, /health
    # to http://gateway:3001 (Docker internal service name) at runtime.
```

```dockerfile
# dashboard/Dockerfile
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

```nginx
# dashboard/nginx.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # SPA routing — all paths serve index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache static assets aggressively (Vite hashes filenames)
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

---

## Project Structure (dashboard/)

```
dashboard/
├── Dockerfile
├── nginx.conf
├── package.json
├── vite.config.js
├── index.html
└── src/
    ├── main.jsx
    ├── App.jsx
    │
    ├── api/                     ← TanStack Query hooks + fetch calls
    │   ├── auth.js
    │   ├── stats.js
    │   ├── graph.js
    │   ├── knowledge.js
    │   ├── pending.js
    │   ├── review.js
    │   ├── bump.js              ← POST /bump/:topic/:key
    │   ├── search.js
    │   ├── config.js
    │   └── health.js
    │
    ├── components/
    │   ├── layout/
    │   │   ├── Sidebar.jsx
    │   │   ├── Header.jsx
    │   │   └── Layout.jsx
    │   │
    │   ├── graph/
    │   │   ├── KnowledgeGraph.jsx   ← Cytoscape.js wrapper
    │   │   ├── NodePanel.jsx        ← slide-in detail on node click
    │   │   └── GraphControls.jsx    ← domain filter, layout toggle
    │   │
    │   ├── pending/
    │   │   ├── DecisionQueue.jsx
    │   │   ├── DecisionCard.jsx
    │   │   ├── ReviewForm.jsx       ← approve/reject/request_changes
    │   │   └── ConflictDiff.jsx     ← side-by-side existing vs incoming
    │   │
    │   ├── knowledge/
    │   │   ├── KnowledgeBrowser.jsx
    │   │   ├── KnowledgeRow.jsx
    │   │   ├── KnowledgeDetail.jsx
    │   │   └── VersionTimeline.jsx
    │   │
    │   ├── audit/
    │   │   ├── AuditTimeline.jsx
    │   │   └── AuditEntry.jsx
    │   │
    │   ├── stats/
    │   │   ├── StatsPanel.jsx
    │   │   ├── DomainChart.jsx
    │   │   ├── ConfidenceHistogram.jsx
    │   │   ├── DecayingKnowledge.jsx    ← bump panel — sortable by confidence
    │   │   └── BumpButton.jsx           ← role-aware, cooldown-enforced
    │   │
    │   ├── config/
    │   │   ├── ConfigEditor.jsx
    │   │   ├── MemberTable.jsx
    │   │   ├── DomainSettings.jsx
    │   │   └── AuthorityWeights.jsx
    │   │
    │   └── status/
    │       ├── SystemStatus.jsx
    │       └── ServiceIndicator.jsx
    │
    ├── context/
    │   └── AuthContext.jsx          ← JWT storage in React context
    │
    └── pages/
        ├── Login.jsx
        ├── Graph.jsx
        ├── Pending.jsx
        ├── Knowledge.jsx
        ├── Audit.jsx
        ├── Stats.jsx
        ├── Config.jsx
        └── Status.jsx
```

---

## Capability Impact Summary

| Capability bar | Before | After | What moves it |
|---------------|--------|-------|---------------|
| Visibility / dashboard | ░░░░░░░░░░░░░░ | ██████████████ | The entire dashboard |
| Platform team UX | ██░░░░░░░░░░░░ | ████████████░░ | Config editor + system status |
| Governance model | ██████████░░░░ | ████████████░░ | Review queue is actionable without Claude |
| Self-evolution loop | ████░░░░░░░░░░ | ████████░░░░░░ | Review half closes; SKILL.md still needed |
| Authority model | ██████░░░░░░░░ | ████████░░░░░░ | Role weights configurable; bump uses same role tiers |
| Audit system | ████████████░░ | █████████████░ | Audit timeline + chain status visible |
| Confidence / decay | ██████░░░░░░░░ | ██████████░░░░ | Decaying Knowledge panel + bump mechanic |

**Remaining gaps after dashboard ships (ignoring external integrations):**
- Notification system: browser polling covers open-tab scenario — full push (webhook/Slack) is a future enhancement
- Self-evolution loop: SKILL.md still needs to be designed and deployed
- Constitutional CI: GAP-02 (minor)

---

## Implementation Order (when ready to build)

1. `dashboard/` scaffold — Vite + React + Tailwind + shadcn setup
2. Auth flow — Login page + AuthContext + `POST /auth/token`
3. Gateway BFF routes — `src/gateway/routes/dashboard.js` (6 new routes: stats, notifications, graph, knowledge, review, search)
4. Stats panel — simplest view, pure PostgreSQL query
5. System status — `/health` + operational indicators
6. Pending decisions queue — highest governance value
7. Decaying Knowledge panel + Bump button — requires confidence decay job (GAP-04) running first
8. Knowledge browser + search
9. Knowledge graph (Cytoscape.js) — most complex, do last
10. Config editor — requires careful validation UX
11. Audit timeline — last, mostly cosmetic

**Note on step 7:** The Decaying Knowledge panel only shows meaningful data once the confidence decay CronJob (GAP-04) has been running for at least a week. Build the UI in parallel, but demo it only after GAP-04 is deployed.

Add to `docker-compose.yml` and `helm/quorum/` when each section is stable.

---

## Open Questions (resolve before implementation)

1. ~~**Notifications:** Should the dashboard poll or use webhooks?~~ **Resolved:** Frontend polling every 60 minutes (configurable) with browser Notifications API. See Notification Strategy section above.
2. ~~**Multi-project UI:** The JWT carries one project at a time. Should the dashboard support switching projects without re-authenticating?~~ **Resolved:** Single JWT carries all projects as an array. Project switch updates `X-Quorum-Project-Id` header in AuthContext — no re-auth needed. Project picker in sidebar reads from JWT `projects` array.
3. **Graph scale:** How many nodes before Cytoscape.js performance degrades? At ~500+ nodes, switch to `dagre` layout only for the visible domain rather than rendering the full graph. May need server-side pagination for the graph endpoint.
4. ~~**Config write path:** The Gateway currently reads config from S3 but has no S3 write route.~~ **Resolved:** Config editor uses `PATCH /projects/:id` (existing Wave 2 route). PostgreSQL is the authoritative config store. S3 path is legacy — not used for config writes.
5. ~~**Notification poll granularity:** The poll fires `GET /api/stats` and checks `pending.total`.~~ **Resolved:** Dedicated `GET /api/notifications` endpoint returns full array with `conflict_id`, `topic`, `key`, `type`, `incoming_author`, `age_hours`. Count = array.length. Client diffs by `conflict_id` set. Full details fetched in parallel on open.
