# Knowledge Deprecation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give principal_architects a first-class deprecate action — from the edit modal, per-row in the knowledge browser, and in bulk via multi-select.

**Architecture:** Two new Express routes in `dashboard.js` (bulk first, parameterised second to avoid Express matching `"deprecate"` as `:topic`). A shared `DeprecateDialog` component is reused by all three UI surfaces. `Knowledge.jsx` gains a checkbox column + `BulkActionBar` + inline icon buttons replacing the kebab menu.

**Tech Stack:** Express + pg transactions (gateway), React 19 + TanStack Query 5 + lucide-react (frontend), Vitest (tests)

---

## File Map

| File | Change |
|---|---|
| `gateway/src/routes/dashboard.js` | Add `POST /knowledge/deprecate/bulk` and `POST /knowledge/:topic/:key/deprecate` before `export default router` |
| `tests/gateway/dashboard-write.test.js` | Add `describe('POST /api/knowledge/deprecate/bulk')` and `describe('POST /api/knowledge/:topic/:key/deprecate')` |
| `dashboard/src/api/knowledge.js` | Add `deprecateKnowledge`, `deprecateKnowledgeBulk`, `bumpKnowledge` + three mutations in `useKnowledgeWrite` |
| `dashboard/src/components/knowledge/DeprecateDialog.jsx` | New focused modal used by all three deprecate surfaces |
| `dashboard/src/components/knowledge/KnowledgeDetail.jsx` | Add `showDeprecate` state + "Deprecate instead" link inside edit modal footer |
| `dashboard/src/pages/Knowledge.jsx` | Remove kebab menu; add checkbox column, inline icons (Trash2/ThumbsUp/Promote), BulkActionBar, DeprecateDialog wiring |

---

## Task 1: Gateway — Bulk Deprecate Route

**Files:**
- Modify: `gateway/src/routes/dashboard.js` (before `export default router`, before Task 2's route)

- [ ] **Step 1: Add the bulk deprecate route**

Insert immediately before `export default router` in `gateway/src/routes/dashboard.js`:

```js
// ── POST /api/knowledge/deprecate/bulk ─────────────────────────────────────────
// IMPORTANT: must be registered BEFORE /knowledge/:topic/:key/deprecate
// to prevent Express matching the literal string "deprecate" as :topic.

/**
 * Bulk-deprecate ACTIVE knowledge entries (principal_architect only).
 * Processes each entry in its own transaction; partial success is allowed.
 *
 * @route POST /api/knowledge/deprecate/bulk
 */
router.post('/knowledge/deprecate/bulk', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const { entries, reason } = req.body ?? {}

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'entries must be a non-empty array' })
  }

  try {
    enforceReasonRequired(reason, 'deprecate')
  } catch (err) {
    return res.status(400).json({ error: 'reason_required', message: err.message })
  }

  const pool        = req.app.locals.pool
  const author      = req.user.sub
  const authorRole  = req.user.role
  const qProjectId  = await resolveQProjectId(req, res).catch(() => null)
  if (!qProjectId) return

  const deprecated = []
  const errors     = []

  for (const { topic, key } of entries) {
    if (!topic || !key) {
      errors.push({ topic, key, message: 'topic and key are required' })
      continue
    }

    try {
      const qKeyId  = await getOrCreateKey(pool, qProjectId, topic, key)
      const current = await getCurrentVersion(pool, qKeyId)

      if (!current) {
        errors.push({ topic, key, message: `No ACTIVE version found for ${topic}:${key}` })
        continue
      }

      const versionId = `${qKeyId}_v${current.version}`
      const client    = await pool.connect()
      try {
        await client.query('BEGIN')
        await transitionVersionStatus(client, versionId, 'DEPRECATED', {
          reason,
          author,
          at: new Date().toISOString(),
        })
        await client.query('COMMIT')
      } catch (txErr) {
        try { await client.query('ROLLBACK') } catch { /* ignore */ }
        errors.push({ topic, key, message: txErr.message })
        continue
      } finally {
        client.release()
      }

      await writeAuditEntry(pool, {
        operation:    'WRITE',
        tool:         'dashboard-deprecate',
        author,
        author_role:  authorRole,
        author_type:  'human',
        triggered_by: 'dashboard',
        q_project_id: qProjectId,
        governance_json: { topic, key, reason },
        outcome_json:    { status: 'DEPRECATED', version: current.version, version_id: versionId },
        version_impact:  { versions_created: [], versions_superseded: [versionId] },
      })

      deprecated.push({ topic, key })
    } catch (err) {
      errors.push({ topic, key, message: err.message })
    }
  }

  res.json({ deprecated, errors })
})
```

- [ ] **Step 2: Run existing tests to verify nothing is broken**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all existing tests still pass (new route not tested yet)

- [ ] **Step 3: Commit**

```bash
git add gateway/src/routes/dashboard.js
git commit -m "feat(gateway): add POST /api/knowledge/deprecate/bulk route"
```

---

## Task 2: Gateway — Single Deprecate Route

**Files:**
- Modify: `gateway/src/routes/dashboard.js` (after bulk route, before `export default router`)

- [ ] **Step 1: Add the single deprecate route**

Insert immediately after the bulk route (Task 1), still before `export default router`:

```js
// ── POST /api/knowledge/:topic/:key/deprecate ──────────────────────────────────

/**
 * Deprecate a single ACTIVE knowledge entry (principal_architect only).
 * Atomically transitions the current ACTIVE version to DEPRECATED.
 *
 * @route POST /api/knowledge/:topic/:key/deprecate
 */
router.post('/knowledge/:topic/:key/deprecate', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const { topic, key } = req.params
  const { reason }     = req.body ?? {}

  try {
    enforceReasonRequired(reason, 'deprecate')
  } catch (err) {
    return res.status(400).json({ error: 'reason_required', message: err.message })
  }

  try {
    const pool        = req.app.locals.pool
    const author      = req.user.sub
    const authorRole  = req.user.role
    const qProjectId  = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const qKeyId  = await getOrCreateKey(pool, qProjectId, topic, key)
    const current = await getCurrentVersion(pool, qKeyId)

    if (!current) {
      return res.status(404).json({ error: 'not_found', message: `No ACTIVE version found for ${topic}:${key}` })
    }

    const versionId = `${qKeyId}_v${current.version}`
    const client    = await pool.connect()
    try {
      await client.query('BEGIN')
      await transitionVersionStatus(client, versionId, 'DEPRECATED', {
        reason,
        author,
        at: new Date().toISOString(),
      })
      await client.query('COMMIT')
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    await writeAuditEntry(pool, {
      operation:    'WRITE',
      tool:         'dashboard-deprecate',
      author,
      author_role:  authorRole,
      author_type:  'human',
      triggered_by: 'dashboard',
      q_project_id: qProjectId,
      governance_json: { topic, key, reason },
      outcome_json:    { status: 'DEPRECATED', version: current.version, version_id: versionId },
      version_impact:  { versions_created: [], versions_superseded: [versionId] },
    })

    res.json({ deprecated: true, topic, key })
  } catch (err) {
    next(err)
  }
})
```

- [ ] **Step 2: Run tests**

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all existing tests pass

- [ ] **Step 3: Commit**

```bash
git add gateway/src/routes/dashboard.js
git commit -m "feat(gateway): add POST /api/knowledge/:topic/:key/deprecate route"
```

---

## Task 3: Gateway — Deprecate Route Tests

**Files:**
- Modify: `tests/gateway/dashboard-write.test.js`

- [ ] **Step 1: Write failing tests — single deprecate**

Append at the end of `tests/gateway/dashboard-write.test.js` (before the final closing `}`):

```js
// ── POST /api/knowledge/:topic/:key/deprecate ──────────────────────────────────

describe('POST /api/knowledge/:topic/:key/deprecate', () => {
  it('returns 403 when caller is not principal_architect', async () => {
    mockUser = { sub: 'bob', project: 'q_p1', role: 'engineer', is_admin: false }
    const { status, body } = await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'No longer valid - replaced by new policy.' })
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 400 when reason is missing', async () => {
    const { status, body } = await post('/api/knowledge/auth/jwt-rotation/deprecate', {})
    expect(status).toBe(400)
    expect(body.error).toBe('reason_required')
  })

  it('returns 400 when reason is less than 10 chars', async () => {
    const { status, body } = await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'too short' })
    expect(status).toBe(400)
    expect(body.error).toBe('reason_required')
  })

  it('returns 404 when no ACTIVE version exists', async () => {
    getCurrentVersion.mockResolvedValue(null)
    const { status, body } = await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'No longer valid - replaced by new policy.' })
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('happy path returns { deprecated: true, topic, key }', async () => {
    getCurrentVersion.mockResolvedValue({ version: 3, confidence: 0.8 })
    const { status, body } = await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'No longer valid - replaced by new policy.' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ deprecated: true, topic: 'auth', key: 'jwt-rotation' })
  })

  it('calls transitionVersionStatus with DEPRECATED', async () => {
    getCurrentVersion.mockResolvedValue({ version: 3, confidence: 0.8 })
    await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'No longer valid - replaced by new policy.' })
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      fakeClient,
      'q_k1_v3',
      'DEPRECATED',
      expect.objectContaining({ reason: 'No longer valid - replaced by new policy.' }),
    )
  })

  it('writes an audit entry with tool dashboard-deprecate', async () => {
    getCurrentVersion.mockResolvedValue({ version: 3, confidence: 0.8 })
    await post('/api/knowledge/auth/jwt-rotation/deprecate', { reason: 'No longer valid - replaced by new policy.' })
    expect(writeAuditEntry).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ tool: 'dashboard-deprecate', operation: 'WRITE' }),
    )
  })
})
```

- [ ] **Step 2: Write failing tests — bulk deprecate**

Append immediately after the single deprecate describe block:

```js
// ── POST /api/knowledge/deprecate/bulk ─────────────────────────────────────────

describe('POST /api/knowledge/deprecate/bulk', () => {
  it('returns 403 when caller is not principal_architect', async () => {
    mockUser = { sub: 'bob', project: 'q_p1', role: 'engineer', is_admin: false }
    const { status } = await post('/api/knowledge/deprecate/bulk', {
      entries: [{ topic: 'auth', key: 'jwt-rotation' }],
      reason: 'Deprecating outdated policy entries now.',
    })
    expect(status).toBe(403)
  })

  it('returns 400 when entries is missing', async () => {
    const { status, body } = await post('/api/knowledge/deprecate/bulk', { reason: 'Deprecating outdated policy entries now.' })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_request')
  })

  it('returns 400 when entries is empty array', async () => {
    const { status, body } = await post('/api/knowledge/deprecate/bulk', { entries: [], reason: 'Deprecating outdated policy entries now.' })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_request')
  })

  it('returns 400 when reason is too short', async () => {
    const { status, body } = await post('/api/knowledge/deprecate/bulk', {
      entries: [{ topic: 'auth', key: 'jwt-rotation' }],
      reason: 'short',
    })
    expect(status).toBe(400)
    expect(body.error).toBe('reason_required')
  })

  it('happy path — all entries deprecated', async () => {
    getCurrentVersion.mockResolvedValue({ version: 1, confidence: 0.8 })
    const { status, body } = await post('/api/knowledge/deprecate/bulk', {
      entries: [
        { topic: 'auth', key: 'jwt-rotation' },
        { topic: 'infra', key: 'retry-policy' },
      ],
      reason: 'Deprecating outdated policy entries now.',
    })
    expect(status).toBe(200)
    expect(body.deprecated).toHaveLength(2)
    expect(body.errors).toHaveLength(0)
  })

  it('partial success — missing ACTIVE version reported in errors', async () => {
    getCurrentVersion
      .mockResolvedValueOnce({ version: 1, confidence: 0.8 })
      .mockResolvedValueOnce(null)

    const { status, body } = await post('/api/knowledge/deprecate/bulk', {
      entries: [
        { topic: 'auth', key: 'jwt-rotation' },
        { topic: 'infra', key: 'nonexistent' },
      ],
      reason: 'Deprecating outdated policy entries now.',
    })
    expect(status).toBe(200)
    expect(body.deprecated).toHaveLength(1)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].key).toBe('nonexistent')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail (expected)**

```bash
npm test -- tests/gateway/dashboard-write.test.js --reporter=verbose 2>&1 | grep -E "✓|×|FAIL|PASS"
```

Expected: new tests FAIL (routes not yet implemented — but they are after Tasks 1+2, so they should PASS if done in order)

- [ ] **Step 4: Run full test suite to confirm all pass**

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass including the new deprecate tests

- [ ] **Step 5: Commit**

```bash
git add tests/gateway/dashboard-write.test.js
git commit -m "test(gateway): add deprecate route tests to dashboard-write suite"
```

---

## Task 4: Frontend API Additions

**Files:**
- Modify: `dashboard/src/api/knowledge.js`

- [ ] **Step 1: Add the three new API functions**

After `supersedeKnowledge` and before `useKnowledgeWrite`, add:

```js
/**
 * Deprecate a single ACTIVE knowledge entry (principal_architect only).
 * @param {string} topic
 * @param {string} key
 * @param {string} reason - Required, min 10 chars
 */
export function deprecateKnowledge(topic, key, reason) {
  return apiFetch(
    `/api/knowledge/${encodeURIComponent(topic)}/${encodeURIComponent(key)}/deprecate`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  )
}

/**
 * Deprecate multiple ACTIVE knowledge entries in a single request.
 * @param {Array<{topic: string, key: string}>} entries
 * @param {string} reason - Shared reason for all entries
 */
export function deprecateKnowledgeBulk(entries, reason) {
  return apiFetch('/api/knowledge/deprecate/bulk', {
    method: 'POST',
    body:   JSON.stringify({ entries, reason }),
  })
}

/**
 * Endorse an ACTIVE knowledge entry (bump its confidence).
 * @param {string} topic
 * @param {string} key
 */
export function bumpKnowledge(topic, key) {
  return apiFetch(
    `/api/bump/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}
```

- [ ] **Step 2: Add three mutations to `useKnowledgeWrite`**

Replace the return statement in `useKnowledgeWrite` with:

```js
  return {
    create:         useMutation({ mutationFn: createKnowledge,   onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    promote:        useMutation({ mutationFn: ({ topic, key, note }) => promoteKnowledge(topic, key, note), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    supersede:      useMutation({ mutationFn: ({ topic, key, ...fields }) => supersedeKnowledge(topic, key, fields), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    deprecate:      useMutation({ mutationFn: ({ topic, key, reason }) => deprecateKnowledge(topic, key, reason), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    deprecateBulk:  useMutation({ mutationFn: ({ entries, reason }) => deprecateKnowledgeBulk(entries, reason), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    bump:           useMutation({ mutationFn: ({ topic, key }) => bumpKnowledge(topic, key), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
  }
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/api/knowledge.js
git commit -m "feat(dashboard): add deprecate/deprecateBulk/bump mutations to useKnowledgeWrite"
```

---

## Task 5: DeprecateDialog Component

**Files:**
- Create: `dashboard/src/components/knowledge/DeprecateDialog.jsx`

- [ ] **Step 1: Create the component**

```jsx
import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

const MAX_CHIPS_SHOWN = 5

/**
 * Focused confirmation dialog for deprecating one or many knowledge entries.
 *
 * @param {Object} props
 * @param {Array<{topic: string, key: string}>} props.entries - Entries to deprecate
 * @param {function(string): Promise<void>} props.onConfirm - Called with validated reason
 * @param {function(): void} props.onCancel
 * @param {boolean} [props.isSubmitting=false]
 * @param {string|null} [props.error=null]
 */
export default function DeprecateDialog({
  entries,
  onConfirm,
  onCancel,
  isSubmitting = false,
  error = null,
}) {
  const [reason, setReason] = useState('')
  const dialogRef = useRef(null)
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])

  useEffect(() => {
    setReason('')
  }, [entries])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancelRef.current() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const isBulk      = entries.length > 1
  const title       = isBulk ? `Deprecate ${entries.length} entries` : 'Deprecate entry'
  const shownChips  = entries.slice(0, MAX_CHIPS_SHOWN)
  const overflow    = entries.length - MAX_CHIPS_SHOWN
  const canConfirm  = !isSubmitting && reason.trim().length >= 10

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={() => { if (!isSubmitting) onCancel() }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl w-full max-w-md p-6 space-y-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-red-500 shrink-0" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
        </div>

        {/* Entry chips */}
        {isBulk && (
          <div className="flex flex-wrap gap-1.5">
            {shownChips.map(({ topic, key }) => (
              <span
                key={`${topic}:${key}`}
                className="font-mono text-[11px] bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-0.5 text-gray-700 dark:text-gray-300"
              >
                {topic}:{key}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-[11px] text-gray-500 self-center">+{overflow} more</span>
            )}
          </div>
        )}

        {!isBulk && (
          <p className="text-sm text-gray-600 dark:text-gray-400 font-mono">
            {entries[0]?.topic}:{entries[0]?.key}
          </p>
        )}

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* Reason */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Reason <span className="text-red-600">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Enter at least 10 characters…"
            className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            rows={3}
            disabled={isSubmitting}
          />
          <p className="text-xs">
            <span className={reason.trim().length >= 10 ? 'text-gray-400' : 'text-amber-400'}>
              {reason.trim().length} / 10 chars minimum
            </span>
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => canConfirm && onConfirm(reason.trim())}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Deprecating…' : 'Deprecate'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/knowledge/DeprecateDialog.jsx
git commit -m "feat(dashboard): add DeprecateDialog component"
```

---

## Task 6: KnowledgeDetail — "Deprecate Instead" Link

**Files:**
- Modify: `dashboard/src/components/knowledge/KnowledgeDetail.jsx`

- [ ] **Step 1: Add import and state**

Add to imports at the top of `KnowledgeDetail.jsx`:

```js
import DeprecateDialog from './DeprecateDialog.jsx'
```

Add `showDeprecate` state after existing `showEdit` and `showPromote`:

```js
const [showDeprecate, setShowDeprecate] = useState(false)
```

- [ ] **Step 2: Add footer link inside the edit modal**

Inside the `{showEdit && ...}` block, after the scrollable `<div className="overflow-y-auto px-6 py-5">` div (which wraps `KnowledgeForm`), add a footer div:

```jsx
{/* Deprecate instead link — visible inside the edit modal */}
<div className="px-6 pb-4 shrink-0 flex justify-center border-t border-gray-100 dark:border-gray-800 pt-3">
  <button
    type="button"
    onClick={() => { write.supersede.reset(); setShowEdit(false); setShowDeprecate(true) }}
    className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400 hover:underline"
  >
    Deprecate this entry instead
  </button>
</div>
```

- [ ] **Step 3: Render DeprecateDialog**

After the `{showEdit && ...}` block and before the `{showPromote && ...}` block, add:

```jsx
{/* Deprecate dialog */}
{showDeprecate && (
  <DeprecateDialog
    entries={[{ topic: row.topic, key: row.key }]}
    onConfirm={async (reason) => {
      await write.deprecate.mutateAsync({ topic: row.topic, key: row.key, reason })
      write.deprecate.reset()
      setShowDeprecate(false)
      onClose()
    }}
    onCancel={() => { write.deprecate.reset(); setShowDeprecate(false) }}
    isSubmitting={write.deprecate.isPending}
    error={write.deprecate.error?.message ?? null}
  />
)}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/knowledge/KnowledgeDetail.jsx
git commit -m "feat(dashboard): add 'Deprecate instead' link to knowledge edit modal"
```

---

## Task 7: Knowledge.jsx — Table Overhaul + Bulk Deprecate

**Files:**
- Modify: `dashboard/src/pages/Knowledge.jsx`

- [ ] **Step 1: Update imports**

Replace:

```js
import { Search, MoreHorizontal } from 'lucide-react';
```

With:

```js
import { Search, Trash2, ThumbsUp } from 'lucide-react';
```

Add `DeprecateDialog` to component imports:

```js
import DeprecateDialog from '../components/knowledge/DeprecateDialog.jsx';
```

- [ ] **Step 2: Add new state and remove kebab state**

Remove:
```js
const [openMenu, setOpenMenu] = useState(null);
```

Remove the `useEffect` that adds/removes the `click` document listener for `openMenu`.

Add after `writeSuccess` state:
```js
const [checkedRows, setCheckedRows]       = useState(new Set())
const [deprecateTarget, setDeprecateTarget] = useState(null) // { entries: [{topic, key}] }
```

- [ ] **Step 3: Update `useKnowledgeWrite` usage**

The `write` object now also has `deprecate`, `deprecateBulk`, and `bump`. No code change needed — they are already part of `useKnowledgeWrite` after Task 4.

- [ ] **Step 4: Add `handleBulkDeprecate` handler**

After the `write` declaration, add:

```js
function handleBulkDeprecate() {
  const entries = Array.from(checkedRows).map((id) => {
    const [topic, ...keyParts] = id.split(':')
    return { topic, key: keyParts.join(':') }
  })
  setDeprecateTarget({ entries })
}
```

- [ ] **Step 5: Add BulkActionBar above the table**

Inside the results section, immediately before `<div className="rounded-lg border...">` (the table container), add:

```jsx
{/* Bulk action bar */}
{isPE && checkedRows.size > 0 && (
  <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
    <span className="text-blue-700 dark:text-blue-300 font-medium">{checkedRows.size} selected</span>
    <button
      onClick={handleBulkDeprecate}
      className="flex items-center gap-1.5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-medium"
      title="Deprecate selected"
    >
      <Trash2 className="h-4 w-4" />
      Deprecate
    </button>
    <button
      onClick={() => setCheckedRows(new Set())}
      className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
    >
      Clear
    </button>
  </div>
)}
```

- [ ] **Step 6: Update table headers to add checkbox column**

Replace the `[...['Domain', 'Key', ...], ...(isPE ? [''] : [])]` header map with:

```jsx
<tr>
  {isPE && (
    <th className="px-3 py-2.5 w-8" />
  )}
  {['Domain', 'Key', 'Type', 'Confidence', 'Author', 'Updated'].map(h => (
    <th
      key={h}
      className="px-4 py-2.5 text-left text-xs font-medium text-gray-500"
    >
      {h}
    </th>
  ))}
  {isPE && (
    <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-500 w-20">Actions</th>
  )}
</tr>
```

- [ ] **Step 7: Update table rows to add checkbox + inline icon buttons**

Replace the entire `<tr key={...}>` block with:

```jsx
{items.map(row => {
  const rowId    = `${row.topic}:${row.key}`
  const isActive = (row.status ?? 'ACTIVE') === 'ACTIVE'
  const isDraft  = (row.status ?? 'ACTIVE') === 'DRAFT'

  return (
    <tr
      key={rowId}
      onClick={() => setSelected(row)}
      className="hover:bg-gray-100/40 dark:hover:bg-gray-800/40 cursor-pointer"
    >
      {isPE && (
        <td
          className="px-3 py-2.5 w-8"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={checkedRows.has(rowId)}
            onChange={(e) => {
              e.stopPropagation()
              setCheckedRows(prev => {
                const next = new Set(prev)
                if (next.has(rowId)) next.delete(rowId)
                else next.add(rowId)
                return next
              })
            }}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
          />
        </td>
      )}
      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 font-mono text-xs">{row.topic}</td>
      <td className="px-4 py-2.5 text-blue-400 font-mono text-xs">{row.key}</td>
      <td className="px-4 py-2.5">
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${entityBadge(row.entity_type)}`}>
          {row.entity_type}
        </span>
      </td>
      <td className="px-4 py-2.5 min-w-[120px]">
        <ConfidenceBar value={row.confidence} showLabel />
      </td>
      <td className="px-4 py-2.5 text-xs text-gray-500">{row.author}</td>
      <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(row.updated_at)}</td>
      {isPE && (
        <td
          className="px-2 py-2.5 w-20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1">
            {isActive && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeprecateTarget({ entries: [{ topic: row.topic, key: row.key }] })
                  }}
                  className="rounded p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="Deprecate"
                  aria-label="Deprecate entry"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    write.bump.mutateAsync({ topic: row.topic, key: row.key })
                  }}
                  className="rounded p-1 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20"
                  title="Bump confidence"
                  aria-label="Bump confidence"
                >
                  <ThumbsUp className="h-4 w-4" />
                </button>
              </>
            )}
            {isDraft && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setPromoteTarget(row)
                }}
                className="text-xs text-green-600 hover:text-green-700 dark:text-green-400 font-medium px-1"
              >
                Promote
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  )
})}
```

- [ ] **Step 8: Remove portal kebab menu**

Delete the entire `{openMenu && createPortal(...)}` block (approximately lines 258–289 of the original file).

- [ ] **Step 9: Add DeprecateDialog render**

After the Promote confirm dialog `{promoteTarget && ...}` block and before the closing `</div>`, add:

```jsx
{/* Deprecate dialog — single or bulk */}
{deprecateTarget && (
  <DeprecateDialog
    entries={deprecateTarget.entries}
    onConfirm={async (reason) => {
      if (deprecateTarget.entries.length === 1) {
        const { topic, key } = deprecateTarget.entries[0]
        await write.deprecate.mutateAsync({ topic, key, reason })
        write.deprecate.reset()
      } else {
        await write.deprecateBulk.mutateAsync({ entries: deprecateTarget.entries, reason })
        write.deprecateBulk.reset()
      }
      setDeprecateTarget(null)
      setCheckedRows(new Set())
    }}
    onCancel={() => {
      write.deprecate.reset()
      write.deprecateBulk.reset()
      setDeprecateTarget(null)
    }}
    isSubmitting={write.deprecate.isPending || write.deprecateBulk.isPending}
    error={write.deprecate.error?.message ?? write.deprecateBulk.error?.message ?? null}
  />
)}
```

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/pages/Knowledge.jsx
git commit -m "feat(dashboard): add checkbox column, inline Trash2/ThumbsUp icons, BulkActionBar, DeprecateDialog wiring"
```

---

## Task 8: Run Full Test Suite + Verify

- [ ] **Step 1: Run all tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass (548+ total)

- [ ] **Step 2: Start the dashboard dev server and verify golden paths**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram/dashboard && npm run dev &
```

Manual checks:
- Open Knowledge browser as PE — verify no kebab menu, Trash2 + ThumbsUp appear on ACTIVE rows, Promote text-button on DRAFT rows
- Click Trash2 on an ACTIVE row → DeprecateDialog opens with single entry chip
- Enter < 10 chars → Confirm stays disabled
- Enter ≥ 10 chars → Confirm enabled (red), click → entry disappears from browser
- Select 3 rows via checkbox → BulkActionBar appears with count + Deprecate button
- Click bulk Deprecate → DeprecateDialog shows 3 chips, single reason field
- Open entry → Edit → "Deprecate this entry instead" link at modal footer → DeprecateDialog opens
- Non-PE user: no checkboxes, no Trash2, no ThumbsUp, no BulkActionBar

- [ ] **Step 3: Final commit (if no issues)**

No additional commit needed — each task already committed.

---

## Verification Checklist (from spec)

- [ ] PE opens ACTIVE entry → Edit modal → "Deprecate this entry instead" → reason → DEPRECATED, disappears from browser
- [ ] PE clicks Trash2 on row directly → same DeprecateDialog → same result
- [ ] PE selects 3 rows → bulk Trash2 enables → one reason → all 3 deprecated
- [ ] Non-PE sees no Trash2, no checkbox, no BulkActionBar
- [ ] Reason < 10 chars → Confirm disabled (client) and 400 (server)
- [ ] Reason is placeholder → 400 from server (enforceReasonRequired)
- [ ] ThumbsUp calls existing bump endpoint — no change to bump logic
