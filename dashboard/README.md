# Quorum Dashboard

React SPA — the human-facing surface for Quorum's governed knowledge graph.

Not published to npm. Deployed by enterprise platform teams alongside the gateway, served via nginx on port **3002**.

> The gateway must be running at `http://localhost:3001` (or `VITE_API_URL`) for the dashboard to function.

---

## What It Does

| Page | Path | Purpose |
|------|------|---------|
| **Stats** | `/stats` | Knowledge base overview: total entries, confidence distribution, top domains, recent activity |
| **Graph** | `/graph` | Interactive knowledge graph (Cytoscape.js) — entity nodes, edges, zoom/filter |
| **Pending** | `/pending` | Conflict resolution queue and DRAFT review — the primary human decision surface |
| **Knowledge** | `/knowledge` | Paginated knowledge browser — filter by topic/status/author, click for detail panel |
| **Audit** | `/audit` | Tamper-evident audit timeline — SHA256 chain, lineage, actor attribution |
| **Config** | `/config` | JSON Schema-validated project config editor + ownership transfer + role management |
| **Admin** | `/admin` | Platform admin panel — add/remove admins (visible to `is_admin` only) |
| **Status** | `/status` | System health: Graphiti, PostgreSQL, Gateway, Redis connectivity |
| **Login** | `/login` | GitHub OAuth entry point |
| **Project Selector** | `/project-select` | Search + paginated project list, cancel-back-to-project support |

---

## Auth Flow

1. User visits `/` — redirected to `/login` if no JWT in AuthContext
2. "Login with GitHub" → `GET /auth/github` → GitHub OAuth
3. Gateway callback issues slim ES256 JWT `{ sub, is_admin }` + returns `project`, `role`, `team`, `base_confidence` in response body (not in JWT claims)
4. `AuthContext._applyJwt(jwt, profile)` stores token + profile; `registerProjectGetter` wires `X-Quorum-Project` into all API calls
5. On 401 → silent refresh via `POST /auth/refresh`; on failure → redirect to `/login`
6. On project switch → new `X-Quorum-Project` header; no new JWT required (v0.3)

---

## API Clients (`src/api/`)

Each file wraps one gateway domain and uses `apiFetch` from `client.js`, which automatically injects:
- `Authorization: Bearer <jwt>` (via registered token getter)
- `X-Quorum-Project: <group_id>` (via registered project getter)

| File | Gateway routes covered |
|------|----------------------|
| `client.js` | Base fetch wrapper, token/refresh/logout/project getter registration |
| `stats.js` | `GET /api/stats` |
| `graph.js` | `GET /api/graph` |
| `knowledge.js` | `GET /api/knowledge`, `GET /api/knowledge/:topic/:key` |
| `pending.js` | `GET /pg/pending`, `POST /api/review/:conflictId` (approve/reject/request_changes) |
| `audit.js` | `GET /pg/audit`, `GET /pg/audit/lineage/:topic/:key` |
| `config.js` | `GET /config`, `PUT /config`, `GET /schema/config` |
| `governance.js` | `POST /config/transfer-ownership`, `POST /config/update-role`, `GET /admin/config`, `POST /admin/users` |
| `bump.js` | `POST /api/bump/:topic/:key` |
| `health.js` | `GET /health` |

---

## Key Components

```
src/
  App.jsx                 — Router, auth guard, callback registrations
  main.jsx                — Vite entry point
  pages/                  — One file per route (see table above)
  components/
    knowledge/
      KnowledgeDetail.jsx — Slide-in panel: content, version history, confidence bar, tags
      VersionTimeline.jsx — Visual version chain with status badges
    stats/
      ConfidenceBar.jsx   — Visual confidence 0–1 bar
    layout/               — Shell, nav, sidebar
    session/              — Session expiry + re-auth modal
    status/               — Per-service health indicator chips
  context/
    AuthContext.jsx       — GitHub OAuth → JWT → project state
    ThemeContext.jsx      — Light/dark theme (persisted in localStorage)
  api/                    — Typed API clients (see above)
  lib/
    utils.js              — entityBadge(), fmtDate(), cn() helpers
```

---

## Development

```bash
npm run dev      # Vite dev server at http://localhost:3002 (hot reload)
npm run build    # Production build → dist/
npm run preview  # Preview production build locally
```

The gateway must be running. Start the full stack from the repo root:

```bash
cd .. && ./scripts/setup.sh docker
```

---

## Docker Build

The production image is a two-stage build: Vite compiles the SPA, nginx serves the `dist/` output and proxies `/api/*`, `/auth/*`, `/pg/*`, `/graphiti/*`, and other gateway paths to `:3001`.

```bash
# From repo root
docker build -f Dockerfile.dashboard -t quorum-dashboard .
```

nginx config: `nginx.conf` — uses `resolver 127.0.0.11 valid=30s` with `set $upstream` to avoid DNS caching issues when gateway container restarts.

---

## Tech Stack

| Library | Version | Purpose |
|---------|---------|---------|
| React | 19 | UI framework |
| React Router | 7 | Client-side routing |
| TanStack Query | 5 | Server state, caching, background refresh |
| Cytoscape.js | latest | Graph visualization (`cose-bilkent` + `dagre` layouts) |
| Tailwind CSS | 3 | Styling |
| Lucide React | latest | Icons |
| Vite | 8 (rolldown) | Build tool |

---

## Notes

- `apiFetch` automatically handles 401 → silent refresh → retry before propagating errors
- `AuthContext` uses `registerProjectGetter(() => user?.project ?? null)` — no project header is sent on public/auth routes since `user` is null before login
- The config editor validates against `GET /schema/config` (Zod schema from gateway) for live JSON validation
- `KnowledgeDetail` fetches `/api/knowledge/:topic/:key` for content (PG `summary` column) and `/pg/versions/:topic/:key/history` for the version timeline — these are separate requests to keep the list query light
