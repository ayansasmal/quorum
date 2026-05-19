# Knowledge Deprecation — Design Spec

**Date:** 2026-05-19
**Status:** Approved
**Author:** ayan (via brainstorming session)

---

## Context

The Quorum constitution (Rule 1) mandates that knowledge is retired via deprecation, never deleted. The `DEPRECATED` status exists in the database schema and `VALID_VERSION_STATUSES`, but there was no API route or UI surface to reach it. This spec closes that gap by giving principal_architects a first-class deprecate action — individually from the edit modal, per-row from the knowledge browser, and in bulk via multi-select.

---

## Scope

Three surfaces:

1. **Edit modal** — "Deprecate this entry instead" link inside the supersede form
2. **Per-row action icons** — inline `Trash2` (deprecate) and `ThumbsUp` (bump) in the table Actions column, replacing the existing `MoreHorizontal` kebab menu
3. **Bulk select + bulk deprecate** — checkbox column + `BulkActionBar` above the table

All three converge on a shared `DeprecateDialog` component.

---

## API

### Single deprecate
```
POST /api/knowledge/:topic/:key/deprecate
Auth: JWT (PE only — same peWriteLimit middleware as promote/supersede)
Body: { reason: string }
```

- Calls `enforceReasonRequired(reason, 'deprecate')` — throws on < 10 chars or placeholder
- Atomically transitions the current ACTIVE version → `DEPRECATED`
- Writes an audit entry: `tool: 'dashboard-deprecate'`, `triggered_by: 'dashboard'`, `author_type: 'human'`
- Returns: `{ deprecated: true, topic, key }`
- 403 if caller is not `principal_architect` or `is_admin`
- 404 if no ACTIVE version exists for `topic:key` in the project

### Bulk deprecate
```
POST /api/knowledge/deprecate/bulk
Auth: JWT (PE only)
Body: { entries: [{ topic: string, key: string }], reason: string }
```

- Same `enforceReasonRequired` check on the shared reason
- Processes each entry atomically in sequence (one transaction per entry)
- Returns: `{ deprecated: [{ topic, key }], errors: [{ topic, key, message }] }`
- Partial success is allowed — entries that fail (e.g. no ACTIVE version) are reported in `errors`; successful ones are committed
- 403 if caller is not PE or admin

**Route ordering note:** `POST /api/knowledge/deprecate/bulk` must be registered before `POST /api/knowledge/:topic/:key/deprecate` in `dashboard.js` to avoid `:topic` matching the literal `"deprecate"`.

---

## Frontend

### New files

**`dashboard/src/components/knowledge/DeprecateDialog.jsx`**

A focused modal used by all three deprecate surfaces:

```
Props:
  entries: [{ topic, key }]   — one or many
  onConfirm(reason): Promise  — called with validated reason
  onCancel(): void
  isSubmitting: bool
  error: string | null
```

- Textarea for reason (≥10 chars), validated client-side before enabling Confirm
- Title adapts: "Deprecate entry" (single) vs "Deprecate {n} entries" (bulk)
- Shows `entries` as a compact list when bulk (topic:key monospace chips, max 5 shown + overflow count)
- Confirm button is red (`bg-red-600`)
- Error banner below textarea if `error` prop is set

### Modified files

**`dashboard/src/api/knowledge.js`**

Add two functions and two mutations to `useKnowledgeWrite()`:

```js
deprecateKnowledge(topic, key, reason)      // POST /api/knowledge/:topic/:key/deprecate
deprecateKnowledgeBulk(entries, reason)     // POST /api/knowledge/deprecate/bulk
```

Mutations: `write.deprecate` and `write.deprecateBulk` — both call `invalidate(queryClient)` on success.

**`dashboard/src/pages/Knowledge.jsx`**

State additions:
```js
const [checkedRows, setCheckedRows] = useState(new Set())   // Set of "topic:key" strings
const [deprecateTarget, setDeprecateTarget] = useState(null) // { entries, isBulk }
```

Table changes:
- New leftmost `<th>` — empty header, PE-only (same conditional as current `''` column)
- Each `<tr>` gets a leftmost `<td>` with a checkbox. `onClick` on the checkbox toggles the row in `checkedRows` and calls `e.stopPropagation()` so the detail panel doesn't open
- Rightmost column replaces the `MoreHorizontal` button with two icon buttons:
  - `Trash2` (deprecate): `e.stopPropagation()`, opens `DeprecateDialog` for this single row. Only shown for ACTIVE entries.
  - `ThumbsUp` (bump): `e.stopPropagation()`, calls `write.bump.mutateAsync({ topic, key })`. Shown for ACTIVE entries.
  - DRAFT entries keep a single "Promote" action (same as current kebab behaviour).
- Clicking a row still opens `KnowledgeDetail` (existing behaviour preserved)

**`BulkActionBar`** (inline in `Knowledge.jsx`, no separate file needed):

```jsx
{checkedRows.size > 0 && (
  <div className="flex items-center gap-3 px-4 py-2 ...">
    <span>{checkedRows.size} selected</span>
    <button onClick={handleBulkDeprecate}><Trash2 /></button>
    <button onClick={() => setCheckedRows(new Set())}>Clear</button>
  </div>
)}
```

Rendered above the table, below the search bar.

**`dashboard/src/components/knowledge/KnowledgeDetail.jsx`**

Inside the supersede modal footer (after the Cancel/Submit buttons), add:

```jsx
<button
  type="button"
  onClick={() => { setShowEdit(false); setShowDeprecate(true) }}
  className="text-xs text-red-500 hover:underline"
>
  Deprecate this entry instead
</button>
```

New state: `const [showDeprecate, setShowDeprecate] = useState(false)`

`DeprecateDialog` rendered conditionally, wired to `write.deprecate`.

---

## Constitutional compliance

| Rule | How satisfied |
|---|---|
| Rule 1 — No hard delete | Status transitions to `DEPRECATED`, never deleted |
| Rule 3 — Reason required | `enforceReasonRequired` called server-side on every deprecate route; client also validates ≥10 chars before enabling Confirm |
| Rule 4 — No self-approval | Not applicable (deprecation is a unilateral PE action, not an approval) |

---

## Files changed

| File | Change |
|---|---|
| `gateway/src/routes/dashboard.js` | Add `POST /api/knowledge/:topic/:key/deprecate` and `POST /api/knowledge/deprecate/bulk` |
| `dashboard/src/api/knowledge.js` | Add `deprecateKnowledge`, `deprecateKnowledgeBulk`, two mutations |
| `dashboard/src/components/knowledge/DeprecateDialog.jsx` | New component |
| `dashboard/src/pages/Knowledge.jsx` | Checkbox column, inline icons, BulkActionBar, DeprecateDialog wiring |
| `dashboard/src/components/knowledge/KnowledgeDetail.jsx` | "Deprecate instead" link + DeprecateDialog state |

---

## Verification

- PE can open an ACTIVE entry → Edit modal → click "Deprecate this entry instead" → enter reason → entry transitions to DEPRECATED, disappears from ACTIVE browser
- PE can click `Trash2` on a row directly → same DeprecateDialog → same result
- PE selects 3 rows → bulk Trash2 enables → one reason → all 3 deprecated in one API call
- Non-PE user sees no Trash2, no checkbox, no BulkActionBar
- Reason < 10 chars → Confirm button stays disabled (client) and 400 (server)
- Reason is placeholder ("TODO") → 400 from server
- Bumping a row via ThumbsUp calls existing `/api/bump/:topic/:key` — no change to bump logic
