# Handoff: Project Visibility Toggle — 2026-06-15

**For:** Codex
**Repo:** `github.com/ayansasmal/quorum` (gateway) + `github.com/ayansasmal/Quorum-dash` (dashboard SPA)
**Feature:** A principal architect or platform admin can toggle a project between public (any authenticated GitHub user has read-only access) and private (members only) from the dashboard Config page.

---

## Background

`is_public` already exists end-to-end:

| Layer | Where |
|-------|-------|
| Schema | `QuorumConfigSchema` in `gateway/src/shared/config/schema.js` — `is_public: z.boolean().optional()` |
| Enforcement | `gateway/src/middleware/verify-jwt.js` — non-members of a private project get `req.user.access_denied = true`; all dashboard routes block them |
| Write API | `PUT /config/:projectId` in `gateway/src/routes/config.js` — principal architect or platform admin, schema-validated, writes to S3 + invalidates Redis |
| Read API | `GET /config/:projectId` already returns the full config including `is_public` |

No new gateway code is needed. This is a pure dashboard UI task.

---

## What to build

A **Visibility card** on the Config page (`quorum-dash/src/pages/Config.jsx`).

### Behaviour

- Shows current visibility: **Public** (globe icon) or **Private** (lock icon)
- Toggle is available to **principal architects and platform admins** — all other users see the current state read-only
- Switching **public → private**: show a confirmation modal ("This will immediately block all non-members. Continue?") before saving
- Switching **private → public**: save immediately (no confirmation needed)
- On save: call `PUT /config/:projectId` with the full config object but `is_public` flipped
- Show success/error feedback inline (same pattern as the existing config save button)

### UI placement

Add the card **above** the raw JSON textarea in `Config.jsx`. Keep it visually separated (e.g. a border-bottom) so the settings card and the raw editor feel like two distinct zones.

---

## Implementation plan

### 1. Read current config shape on the Config page

`Config.jsx` already fetches `GET /config/:projectId` via `useQuery`. The response shape is the raw config object. `is_public` will be `true`, `false`, or `undefined` (treat `undefined` as `false` — private by default).

### 2. Add a `VisibilityCard` component

Create `quorum-dash/src/components/config/VisibilityCard.jsx`:

```jsx
// Props: isPublic (bool), onChange (fn), canManageVisibility (bool), isSaving (bool)
```

- Renders a card with title "Project visibility"
- Two options: "Public" and "Private" shown as a pill toggle or radio group
- Lock/Globe icon alongside each label
- If `!canManageVisibility`: render read-only (no toggle, just display current state)
- If `canManageVisibility`: render an interactive toggle
- When switching to private: open the existing `ConfirmDialog` before calling `onChange`

### 3. Wire the save to `PUT /config/:projectId`

In `Config.jsx`, add a `handleVisibilityChange(newIsPublic)` handler:

```js
async function handleVisibilityChange(newIsPublic) {
  const updated = { ...draft, is_public: newIsPublic }
  await save.mutateAsync(updated)
  setDraft(updated)
}
```

Use the existing `useSaveConfig()` mutation already used by `Config.jsx`. It calls `PUT /config/:projectId` and invalidates the config query. Show `save.isPending` on the card while saving.

### 4. Role check

Project roles are not authoritative on `user` because the dashboard uses slim JWTs. Read the active-project role from `AuthContext` → `currentProjectData.role`, and read the platform-admin flag from `user.is_admin`:

```js
const canManageVisibility =
  currentProjectData?.role === 'principal_architect' || user?.is_admin === true
```

### 5. Confirmation modal

Reuse `quorum-dash/src/components/knowledge/ConfirmDialog.jsx` for the public→private transition. Message:

> **Make project private?**
> This will immediately revoke read access for all non-members. Members are unaffected.
> [Cancel] [Make Private]

---

## Key files to read first

**Gateway (for API contract):**
- `gateway/src/routes/config.js` — `PUT /config/:projectId` handler (principal architect or platform admin role check, schema validation, S3 write, Redis invalidation)
- `gateway/src/shared/config/schema.js` — `QuorumConfigSchema` (confirm `is_public` field)

**Dashboard:**
- `quorum-dash/src/pages/Config.jsx` — existing Config page (where to add the card)
- `quorum-dash/src/api/config.js` — `useConfig`, `useValidateConfig`, and `useSaveConfig`
- `quorum-dash/src/components/knowledge/ConfirmDialog.jsx` — existing confirmation component to reuse

---

## What NOT to do

- Do not add a new gateway endpoint — `PUT /config/:projectId` already handles this
- Do not allow users other than principal architects or platform admins to toggle visibility (the gateway is authoritative, but the UI should mirror it)
- Do not replace the raw JSON editor — keep it below the new card
- Do not change the enforcement logic in `verify-jwt.js` — it already works correctly

---

## Acceptance criteria

1. A principal architect or platform admin on a private project sees a "Public / Private" toggle on the Config page
2. Toggling public → private shows a confirmation modal; cancelling leaves the project public
3. On confirm (or on private → public toggle), `PUT /config/:projectId` is called with `is_public` updated and inline success feedback is shown
4. Users who are neither principal architects nor platform admins see the current visibility state read-only, with no toggle
5. After making a project public, an authenticated GitHub user who is not a member can `GET /api/knowledge` without a 403
6. After making a project private, that same authenticated non-member gets 403
