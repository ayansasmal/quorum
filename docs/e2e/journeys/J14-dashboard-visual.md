# J14 — Dashboard Visual & Interaction Flows

**Scenario ID:** S-14
**Weight:** 30 (20 raw leaves × F1.5)
**Blast radius:** 3.2% of suite
**Frequency tier:** F1.5 (periodic — visual regression checked on scheduled runs and after frontend changes)
**Spec file:** `tests/e2e/scenarios/14-dashboard-visual.spec.js`

---

## What It Covers

All UI interactions not covered by governance journeys — the knowledge graph visualization,
the config editor, system status page, audit timeline detail, and the project selector search.
This is the only scenario where Playwright is used purely as a browser driver (no API assertions
in sub-flows that are already covered by other scenarios).

**Roles:** `test-pe`, `test-engineer`
**Touches:** `/graph`, `/config`, `/status`, `/audit`, project selector
**Automated:** Yes — Playwright (browser-only)

> Note: graph *layout quality* and *visual clarity* cannot be asserted programmatically.
> This scenario asserts node presence, panel rendering, and error states — not aesthetics.
> See [MANUAL-TESTS.md](../MANUAL-TESTS.md) MT-04 for the visual quality check.

---

## Setup

Seed 3 ACTIVE knowledge entries across domains `auth` and `infra` via `test-pe`.
This ensures the graph has nodes to render.

---

## Sub-Flows

### 14a — Knowledge Graph (`/graph`)

1. Navigate to `/graph` as `test-pe`
   - Assert: graph canvas renders (Cytoscape element visible, not empty/error state)

2. With < 500 ACTIVE entries: no domain filter required
   - Assert: multiple nodes visible (≥ 3 from our seed data)
   - Assert: no "domain filter required" error message

3. Click a knowledge node
   - Assert: detail panel opens on the right
   - Assert: panel shows `topic`, `key`, `content` (non-empty), `author`

4. Navigate to `/graph?domain=auth`
   - Assert: only `auth` nodes visible in the graph
   - Assert: `infra` nodes not rendered

5. Simulate > 500 entries limit via `GET /api/graph` without domain filter (API call, not UI):
   - Assert: `400` response with helpful message: "Add a domain filter..."
   - (Note: do not actually seed 500 entries — test the API guard via direct call with mocked count)

---

### 14b — Config Editor (`/config`)

6. Navigate to `/config` as `test-pe`
   - Assert: JSON editor panel renders with current project config JSON visible

7. Modify the `project` display name field (valid change):
   - Edit JSON to change `"project": "E2E Test Service"` → `"project": "E2E Test Service (updated)"`
   - Click Save
   - Assert: success toast or confirmation visible
   - Assert: page title or config header updates to reflect new display name

8. Introduce invalid JSON syntax (e.g., remove a closing brace):
   - Assert: Save button is disabled or produces inline error (JSON parse error shown)
   - Assert: config is NOT saved (no API call made with malformed JSON)

9. Restore valid JSON but with a Zod schema violation (e.g., set `is_global: "yes"` instead of boolean):
   - Assert: Save produces a `400` response with field-level validation error shown in the editor

---

### 14c — System Status (`/status`)

10. Navigate to `/status` as `test-pe`
    - Assert: status page renders with service health indicators for:
      - PostgreSQL
      - FalkorDB / Graphiti
      - Redis
      - LocalStack (S3)
    - Assert: all indicators green (all services healthy in test stack)

---

### 14d — Audit Timeline (`/audit`)

11. Navigate to `/audit` as `test-pe`
    - Assert: audit entries listed in reverse-chronological order (most recent first)
    - Assert: each row shows at minimum: operation type, tool, author, timestamp

12. Click an audit entry row
    - Assert: expanded detail panel opens
    - Assert: `governance_json` section shows the intent payload
    - Assert: `outcome_json` section shows the result

---

### 14e — Project Selector

13. Click the project dropdown in the navigation bar
    - Assert: search input field appears
    - Assert: initial list shows available projects (at least `quorum-test-project` and `quorum-test-catalog`)

14. Type partial name `"catalog"` in the search field
    - Assert: results filter in real-time to show only `quorum-test-catalog`
    - Assert: `quorum-test-project` not visible in filtered results

15. Press Escape or click Cancel
    - Assert: dropdown closes without switching project
    - Assert: active project in header/nav is unchanged (still `quorum-test-project`)

---

## Pass Criteria

- [ ] Knowledge graph renders with nodes present from seed data
- [ ] Graph node click opens detail panel with correct fields
- [ ] `?domain=auth` filter shows only auth-domain nodes
- [ ] `GET /api/graph` without domain filter when entry count is high → `400` with guidance message
- [ ] Config editor shows current project config JSON
- [ ] Valid config edit saves successfully
- [ ] Invalid JSON → save blocked (no API call with malformed data)
- [ ] Zod schema violation → `400` with field-level error shown in editor
- [ ] System status page shows all services green in test stack
- [ ] Audit timeline shows entries in reverse-chronological order
- [ ] Expanded audit entry shows governance_json and outcome_json
- [ ] Project selector search filters results in real-time
- [ ] Cancel closes selector without switching project
