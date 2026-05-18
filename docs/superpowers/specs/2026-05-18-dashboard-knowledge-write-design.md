# Dashboard Knowledge Write — Design Spec

**Date:** 2026-05-18
**Status:** Approved
**Scope:** Allow `principal_architect` users to create, promote, and supersede knowledge entries directly from the dashboard UI, with full security hardening applied to both the dashboard and MCP write paths.

---

## 1. Context

The dashboard has been read-only for knowledge (browse, search, detail view). The only existing write paths are:

- `POST /api/review/:conflictId` — approve/reject DRAFT entries (all roles)
- `POST /api/bump/:topic/:key` — confidence endorsement (all roles)

All knowledge creation and editing flows exclusively through the MCP server (Claude Code). This spec adds a governed write surface to the dashboard for `principal_architect` users, and hardens validation across all write paths (dashboard + MCP) with shared rules.

---

## 2. Knowledge Lifecycle (reference)

```
WRITE (MCP or Dashboard)
        │
        ▼
      DRAFT ──── reviewer approves ──► ACTIVE ──── new version ──► SUPERSEDED
        │                                 │
        │         reviewer rejects        │
        ▼                                 ▼
     REJECTED                        DEPRECATED  (via forget())
```

**Legal transitions (enforced in `queries.js`):**

| From | To | Trigger |
|------|----|---------|
| `DRAFT` | `ACTIVE` | Review approval OR PE direct promote |
| `DRAFT` | `REJECTED` | Review rejection |
| `ACTIVE` | `SUPERSEDED` | Atomic supersede (new version written) |
| `ACTIVE` | `DEPRECATED` | `forget()` MCP tool |

**Invariant:** Only one `ACTIVE` version per `topic:key` at any time.

---

## 3. Principal Architect Capabilities (new)

| Action | Entry state | Result | Backend call |
|--------|-------------|--------|--------------|
| Add new entry | — | New `ACTIVE` entry | `POST /api/knowledge` |
| Promote draft | `DRAFT` exists | `DRAFT` → `ACTIVE` | `POST /api/knowledge/:topic/:key/promote` |
| Edit existing | `ACTIVE` exists | New `ACTIVE` + old `SUPERSEDED` | `POST /api/knowledge/:topic/:key/supersede` |

All other roles: read-only on the knowledge browser. Promote and Edit actions are invisible unless `role === 'principal_architect'`.

---

## 4. Shared Validation Module

**New file:** `gateway/src/shared/graph/validate.js`

Exports `validateKnowledgeInput(fields)`. Throws `ValidationError` (structured: `{ field, message }`) on any violation. Called before any DB operation in all four write routes.

**Rules:**

| Field | Constraint | Regex / rule |
|-------|-----------|--------------|
| `topic` | Required, max 60 chars | `/^[a-z0-9-]+$/` |
| `key` | Required, max 80 chars | `/^[a-z0-9-]+$/` |
| `content` / `summary` | Required, max 500 chars | No `<` or `>` characters |
| `entity_type` | Required | Enum: `Decision`, `Pattern`, `Constraint`, `Runbook`, `Requirement` |
| `tags` | Optional, max 10 items | Each tag: `/^[a-z0-9-]+$/`, max 40 chars |
| `confidence` | Optional, default 0.7 | Float `0.5 – 1.0` |
| `reason` | Required for supersede/promote | Min 10 chars, max 500 chars, no `<` or `>` |

Vendored copy must be synced to `quorum-mcp/src/shared/graph/validate.js` — same manual sync process as `queries.js` and `constitutional.js`.

**Enforcement routes:**

| Route | File |
|-------|------|
| `POST /pg/versions` | `gateway/src/routes/pg.js` |
| `POST /pg/versions/supersede` | `gateway/src/routes/pg.js` |
| `POST /api/knowledge` | `gateway/src/routes/dashboard.js` |
| `POST /api/knowledge/:topic/:key/promote` | `gateway/src/routes/dashboard.js` |
| `POST /api/knowledge/:topic/:key/supersede` | `gateway/src/routes/dashboard.js` |

---

## 5. Backend — New Dashboard BFF Endpoints

All three endpoints are added to `gateway/src/routes/dashboard.js`. All require valid JWT + `X-Quorum-Project`. Role check (`principal_architect`) runs before validation.

### 5.1 `POST /api/knowledge` — Create new ACTIVE entry

**Request body:**
```json
{
  "topic": "auth",
  "key": "token-strategy",
  "content": "Use JWT for Lambda services...",
  "entity_type": "Decision",
  "tags": ["auth", "lambda", "security"],
  "confidence": 0.85
}
```

**Server-side only (never from body):**
- `author` ← `req.user.sub`
- `author_role` ← `req.user.role`
- `author_type` ← `'human'`
- `triggered_by` ← `'dashboard'`
- `content_hash` ← `SHA256(content)`
- `version_id` ← derived from `q_key_id + nextVersion`
- `q_project_id` ← from JWT resolution
- `status` ← `'ACTIVE'`

**Flow:**
1. Role check → 403 if not `principal_architect`
2. `validateKnowledgeInput(body)` → 400 on violation
3. `resolveQProjectId` → 404 if project not registered
4. `getOrCreateKey(pool, qProjectId, topic, key)`
5. `getNextVersionNumber(pool, qKeyId)`
6. `insertVersion(pool, record)`
7. `writeAuditEntry(...)` with `triggered_by: 'dashboard'`
8. Return `201` with the inserted version row

**Rate limit:** 10 requests/min/IP
**Payload cap:** `express.json({ limit: '4kb' })` scoped to these routes

---

### 5.2 `POST /api/knowledge/:topic/:key/promote` — Promote DRAFT → ACTIVE

**Request body:**
```json
{ "note": "Verified against current architecture — promoting to active." }
```

**Flow:**
1. Role check → 403
2. Validate `note` (min 10 chars, max 500, no HTML) → 400
3. `resolveQProjectId`
4. `getOrCreateKey` → resolve `qKeyId`
5. `getLatestDraftVersion(pool, qKeyId)` → 404 if no DRAFT exists
6. `transitionVersionStatus(pool, draftVersionId, 'ACTIVE', forwardLink)`
7. `writeAuditEntry(...)`
8. Return `200` with promoted version

---

### 5.3 `POST /api/knowledge/:topic/:key/supersede` — Edit ACTIVE entry

**Request body:** same fields as create + required `reason`
```json
{
  "topic": "auth",
  "key": "token-strategy",
  "content": "Updated: use JWT for Lambda; session tokens for ECS...",
  "entity_type": "Decision",
  "tags": ["auth", "lambda", "ecs", "security"],
  "confidence": 0.90,
  "reason": "Expanded to cover ECS services after platform review."
}
```

**Flow:**
1. Role check → 403
2. `validateKnowledgeInput(body)` → 400
3. `resolveQProjectId`
4. `getOrCreateKey`
5. `getCurrentVersion(pool, qKeyId)` → 404 if no ACTIVE exists
6. `getNextVersionNumber`
7. `atomicSupersede(pool, newVersionRecord, currentVersion.version, reason, forwardLink)`
8. `writeAuditEntry(...)`
9. Return `200` with `{ new_version, superseded_version }`

---

## 6. MCP — Zod Schema Updates

Files: `quorum-mcp/src/tools/remember.js`, `reflect.js`

Update Zod schemas so the LLM sees constraints before making tool calls:

```js
content: z.string()
  .max(500, 'Knowledge content must be under 500 characters')
  .refine(v => !/[<>]/.test(v), 'Plain text only — no HTML characters (< >)')
  .describe('Knowledge content — plain text, max 500 chars, no HTML'),

topic: z.string()
  .regex(/^[a-z0-9-]+$/, 'topic must be kebab-case (e.g. "auth", "db-layer")')
  .max(60)
  .describe('Domain/topic — kebab-case slug, max 60 chars'),

key: z.string()
  .regex(/^[a-z0-9-]+$/, 'key must be kebab-case (e.g. "token-strategy")')
  .max(80)
  .describe('Knowledge key — kebab-case slug, max 80 chars'),

tags: z.array(
  z.string()
    .regex(/^[a-z0-9-]+$/, 'Each tag must be kebab-case')
    .max(40)
).max(10).optional()
  .describe('Cross-domain search tags — max 10, each kebab-case, max 40 chars'),

reason: z.string()
  .min(10, 'Reason must be at least 10 characters')
  .max(500)
  .refine(v => !/[<>]/.test(v), 'Plain text only — no HTML characters')
  .describe('Reason for this change — min 10 chars, plain text')
```

Zod validation runs in the MCP process — invalid input returns a structured tool error before any gateway call.

---

## 7. Quorum Skill — Knowledge Guidelines Update

File: `quorum-mcp/skill/references/knowledge-guidelines.md`

Add a **Content Constraints** section so the LLM internalises limits at session start:

```markdown
## Content Constraints (enforced by gateway and MCP)

| Field | Constraint |
|-------|-----------|
| `content` / `summary` | Max 500 chars, plain text, no HTML (`<` `>` forbidden) |
| `topic` | Kebab-case slug, max 60 chars (`auth`, `db-layer`) |
| `key` | Kebab-case slug, max 80 chars (`token-strategy`) |
| `tags` | Max 10 tags, each kebab-case, max 40 chars |
| `reason` | Min 10 chars, max 500 chars, plain text |
| `confidence` | Float 0.5–1.0 |

These are hard limits — the gateway rejects violations with a 400. Write concisely.
```

---

## 8. Frontend

### 8.1 Components

**Modified:**
- `dashboard/src/pages/Knowledge.jsx` — add `⋯` action menu on each row (PE only); "Add entry" button in filter bar (PE only); wire `ConfirmDialog` and `KnowledgeForm`
- `dashboard/src/components/knowledge/KnowledgeDetail.jsx` — add Promote and Edit buttons for PE when viewing a DRAFT or ACTIVE entry
- `dashboard/src/api/knowledge.js` — add `createKnowledge()`, `promoteKnowledge()`, `supersedeKnowledge()`

**New:**
- `dashboard/src/components/knowledge/KnowledgeForm.jsx` — controlled form (topic, key, content textarea, entity_type select, tags input, confidence slider). Used for both Create and Edit (supersede). Pre-fills fields when editing.
- `dashboard/src/components/knowledge/ConfirmDialog.jsx` — reusable confirmation overlay with title, body text, confirm label, and destructive flag.

### 8.2 Row Actions (PE only)

Each table row gets a `⋯` button (visible only to PE) that opens a dropdown:

| Entry status | Actions shown |
|--------------|--------------|
| `ACTIVE` | Edit (supersede) |
| `DRAFT` | Promote to Active |

### 8.3 Confirmation Dialogs

| Action | Dialog text |
|--------|------------|
| Promote DRAFT → ACTIVE | "Promote this entry to Active? It will replace any existing Active version for `{topic}:{key}`." + required note field |
| Edit / Supersede ACTIVE | "This will create a new version and archive the current one. This cannot be undone." + required reason field |

"Add new entry" has no separate confirmation — the form submit button is the confirmation.

### 8.4 Form Fields

| Field | Input type | Validation (client-side) |
|-------|-----------|--------------------------|
| Topic | Text input | `/^[a-z0-9-]+$/`, max 60, required |
| Key | Text input | `/^[a-z0-9-]+$/`, max 80, required |
| Content | Textarea | Max 500 chars, no `<>`, required. Live char counter. |
| Entity type | Select | Enum options |
| Tags | Text input (comma-separated) | Each tag `/^[a-z0-9-]+$/`, max 10 |
| Confidence | Range slider 0.5–1.0 | Step 0.05 |
| Reason | Textarea (supersede/promote only) | Min 10 chars, max 500 |

### 8.5 State / Query Invalidation

On any successful write, invalidate `['knowledge']` and `['stats']` TanStack Query keys to refresh the browser and stats panel. Show an inline success message. On error, display the `message` field from the gateway 400/403 response.

---

## 9. Security Posture Summary

| Concern | Enforcement |
|---------|------------|
| Role gate | `req.user.role !== 'principal_architect'` → 403 (server-side, every endpoint) |
| Author identity | Always `req.user.sub` from JWT — never from request body |
| `author_type` | Hardcoded `'human'` server-side |
| `triggered_by` | Hardcoded `'dashboard'` server-side |
| `content_hash` | Computed server-side from content |
| `version_id` | Derived server-side |
| `q_project_id` | From JWT resolution — never from body |
| Input validation | `validateKnowledgeInput()` — shared module, three enforcement layers |
| Payload cap | `express.json({ limit: '4kb' })` on write routes |
| Rate limiting | 10 write requests/min/IP on write routes |
| CSRF | Not applicable — Bearer token auth, no cookies |
| Concurrent supersede | Atomic transaction + `WHERE status = 'ACTIVE'` guard |
| Audit chain | `writeAuditEntry` on every write — tamper-evident SHA256 chain |
| No hard delete | `BLOCKED_METHODS` in `graph/client.js` — structural |

---

## 10. Files to Create / Modify

| File | Change |
|------|--------|
| `gateway/src/shared/graph/validate.js` | **New** — shared validation module |
| `gateway/src/routes/dashboard.js` | Add 3 endpoints + import validate + scoped rate limit + payload cap |
| `gateway/src/routes/pg.js` | Add `validateKnowledgeInput` call to `POST /pg/versions` and `POST /pg/versions/supersede` |
| `quorum-mcp/src/shared/graph/validate.js` | **New** — vendored copy (manual sync) |
| `quorum-mcp/src/tools/remember.js` | Update Zod schemas with constraints |
| `quorum-mcp/src/tools/reflect.js` | Update Zod schemas with constraints |
| `quorum-mcp/skill/references/knowledge-guidelines.md` | Add Content Constraints section |
| `dashboard/src/pages/Knowledge.jsx` | Add PE action menu + Add button |
| `dashboard/src/components/knowledge/KnowledgeDetail.jsx` | Add Promote / Edit buttons for PE |
| `dashboard/src/components/knowledge/KnowledgeForm.jsx` | **New** — create/edit form |
| `dashboard/src/components/knowledge/ConfirmDialog.jsx` | **New** — confirmation overlay |
| `dashboard/src/api/knowledge.js` | Add `createKnowledge`, `promoteKnowledge`, `supersedeKnowledge` |

---

## 11. Testing

- `validateKnowledgeInput` — unit tests: all field rules, boundary values (500 chars, 501 chars, HTML chars, empty tags array, 11 tags)
- `POST /api/knowledge` — route tests: 403 for non-PE, 400 for invalid input, 201 for valid PE write; confirm `author`, `author_type`, `triggered_by` are server-set
- `POST /api/knowledge/:topic/:key/promote` — 404 when no DRAFT, 403 for non-PE, 200 for valid promote
- `POST /api/knowledge/:topic/:key/supersede` — 404 when no ACTIVE, atomicity (no partial state), 403 for non-PE
- `POST /pg/versions` — confirm validation now fires (regression: previously unvalidated)
- MCP Zod schemas — unit test that over-length content and HTML chars are rejected before gateway call
