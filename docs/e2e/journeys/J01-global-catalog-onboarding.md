# J01 — Global Catalog Onboarding

**Scenario ID:** S-01
**Weight:** 15 (raw leaves: 15, F: 1.0)
**Blast radius:** 1.6% of suite — Low
**Frequency tier:** F1 (one-time lifecycle operation)
**Spec file:** `tests/e2e/scenarios/01-global-catalog-onboarding.spec.js`

---

## What It Covers

Full setup flow — upload a global catalog config, link a normal project to it, verify cross-catalog reads work from both the API and the dashboard. This is the foundational onboarding story: the first thing a principal architect does when setting up a new team.

**Roles:** `test-pe` (setup), `test-architect` (global writes), `test-engineer` (cross-catalog reads)
**Touches:** `POST /config/upload`, `GET /api/globals`, `POST /api/knowledge`, `GET /api/search`, `/knowledge` page, `/stats` page
**Automated:** Yes — Playwright + API calls

---

## Setup

```javascript
// Fresh config uploads — no prior state needed
// test-private-key.pem used to generate JWTs for all roles
```

---

## Steps

### API Phase

1. Upload `quorum-test-catalog.quorum.json` via `POST /config/upload` as `test-pe`
   - Assert: `201`, body contains `group_id: "quorum-test-catalog"`

2. Upload `quorum-test-project.quorum.json` via `POST /config/upload` as `test-pe`
   - Assert: `201`, body confirms `globals: ["quorum-test-catalog"]` accepted

3. `GET /api/globals` as `test-pe`, scoped to `quorum-test-project`
   - Assert: response array includes entry with `group_id: "quorum-test-catalog"`, `is_global: true`

---

### UI Phase — PE (catalog project)

4. Log in as `test-pe`, active project = `quorum-test-catalog`
   - Navigate to `/knowledge`
   - Assert: empty-state message visible (no entries yet)

5. Create a knowledge entry via `POST /api/knowledge`:
   - `topic: "security"`, `key: "tls-minimum-version"`
   - `content: "All services must use TLS 1.3 minimum. TLS 1.2 is permitted only for legacy internal endpoints until Q3 migration."`
   - Assert: response `status: "ACTIVE"` (PE writes to global catalog land as ACTIVE immediately)

6. Navigate to `/knowledge`
   - Assert: `tls-minimum-version` entry visible with green `ACTIVE` badge

7. Navigate to `/stats`
   - Assert: `UNCERTIFIED` conformance badge visible (only 1 entry — need ≥ 10 for CERTIFIED)

---

### UI Phase — Architect (global write → DRAFT)

8. Log in as `test-architect`, active project = `quorum-test-catalog`

9. Create a second entry via dashboard knowledge form:
   - `topic: "auth"`, `key: "token-expiry"`, `content: "Access tokens must expire within 1 hour. Refresh tokens within 30 days."`
   - Assert: entry lands as `DRAFT` (architect writes to a global catalog are always DRAFT — only PA can directly ACTIVE)

10. Navigate to `/pending`
    - Assert: "Draft entries awaiting review" section shows the architect's `auth:token-expiry` entry

11. Log back in as `test-pe`, navigate to `/pending`
    - Approve the draft with note: `"Standard is correct per security policy"`
    - Assert: entry transitions to `ACTIVE` in the Knowledge browser

---

### UI Phase — Engineer (cross-catalog reads)

12. Log in as `test-engineer`, active project = `quorum-test-project`

13. Call `GET /api/search?q=TLS` (or use dashboard search box)
    - Assert: `quorum-test-catalog`'s `security:tls-minimum-version` entry appears in results
    - Assert: result object has `source: "global"` and `catalog_id: "quorum-test-catalog"`

14. Navigate to `/knowledge`
    - Assert: global entries do NOT appear in the knowledge browser (browser shows only project-local ACTIVE entries)
    - Assert: no `tls-minimum-version` row visible (no global bleed)

---

## Pass Criteria

- [ ] Global catalog config uploads → `201` with correct `group_id`
- [ ] PE writes to global catalog → `ACTIVE` immediately (no approval required)
- [ ] Architect writes to global catalog → `DRAFT`, appears in `/pending`, requires PA approval
- [ ] After PA approval → entry is `ACTIVE` in Knowledge browser
- [ ] Search from linked project returns global entries annotated `source: "global"`, `catalog_id` set
- [ ] Knowledge browser (`/knowledge`) shows only project-local entries — no global bleed
- [ ] Stats page shows `UNCERTIFIED` badge when global catalog has fewer than 10 ACTIVE entries

---

## Teardown

```javascript
// Delete both test projects from q_projects + S3
// Remove all knowledge entries created during this scenario
```

---

## Related Scenarios

- **S-04** (Deviation Governance) — also sets up a global catalog, but self-contained
- **S-07** (Conformance) — verifies UNCERTIFIED → CERTIFIED transition in detail
- **S-05.4** (RBAC: governance) — tests global write authority rules exhaustively
