# Quorum Dashboard

React SPA for the Quorum governance UI. Private — deployed by enterprise teams alongside the gateway.

Not published to npm. Teams build and serve it via Docker or static hosting behind the gateway.

Runs on port **3002** by default (Vite dev server).

---

## Purpose

Visual interface for engineering teams to:

- View the **knowledge graph** (Cytoscape.js)
- Review and resolve **pending decisions** (conflict queue)
- Browse **knowledge versions** with status and confidence
- Manage **deviations** from global catalog standards (accept / deny / defer)
- Track **portfolio conformance** across the org hierarchy (exec-gated)
- Inspect the **audit timeline** (tamper-evident chain)
- Edit **project config** with JSON Schema validation
- Monitor **system status** (Graphiti, PostgreSQL, gateway)

---

## Key Files

```
src/
  App.jsx                 — Router setup, auth guard
  main.jsx                — Vite entry point
  pages/
    Stats.jsx             — Overview stats + metrics + ConformanceCard (v0.4)
    Graph.jsx             — Knowledge graph (Cytoscape.js)
    Pending.jsx           — Pending decisions queue + overdue deferrals (v0.4)
    Knowledge.jsx         — Knowledge browser (version list) + denial_hint_count badge (v0.4)
    Deviations.jsx        — Deviation table + inline accept/deny/defer action panel (v0.4)
    Portfolio.jsx         — Org rollup banner + 4-level cascading filters + project table (v0.4)
    Audit.jsx             — Audit timeline
    Config.jsx            — Project config editor + Global Catalogs card (v0.4)
    Status.jsx            — System health status
    Admin.jsx             — Platform admin panel
    Login.jsx             — GitHub OAuth entry point
    ProjectSelector.jsx   — Project search + switch
  components/
    layout/               — Shell, nav, sidebar
    session/              — Session management components
    status/               — Status indicator components
  context/
    AuthContext.jsx        — GitHub OAuth → JWT state
    ThemeContext.jsx       — Light/dark theme
  api/                    — Typed API clients (one per domain)
  lib/                    — Shared utilities
```

---

## Development

```bash
npm run dev      # Vite dev server at http://localhost:3002
npm run build    # Production build → dist/
npm run preview  # Preview production build
```

The gateway must be running at `http://localhost:3001` for the dashboard to function.

---

## Auth Flow

1. User visits `/` — redirected to `/login` if no JWT
2. Click "Login with GitHub" → `GET /auth/login` → GitHub OAuth
3. Gateway callback → issues ES256 JWT + refresh token → stored in AuthContext
4. All API calls include `Authorization: Bearer <jwt>` header
5. On 401 → attempt silent refresh via `POST /auth/refresh`; on failure → back to `/login`

---

## Theme

Full light/dark theme via `ThemeContext`. Toggle in nav. Preferences persisted in localStorage.

---

## Notes

- Uses React 19 + React Router 7 + TanStack Query 5
- Graph visualization: Cytoscape.js with `cose-bilkent` + `dagre` layouts
- Config editor: validates against `GET /schema/config` JSON Schema from the gateway
- Project selector: search + pagination (10/page), supports cancel-back-to-project
