# Public Project Discovery — Design

**Date:** 2026-06-17
**Status:** Approved, pending implementation plan

## Problem

`ayan-portfolio` was marked `is_public: true` via the dashboard Config page. A
random, non-member GitHub user signed in and saw the `NoProjects.jsx` welcome
page ("Hi `<username>`, there are no Quorum projects accessible to you")
instead of the public project.

Root cause: `is_public` today only relaxes the **API-layer read gate** in
`gateway/src/middleware/verify-jwt.js` — when a request already carries
`X-Quorum-Project: <group_id>`, a non-member is let through for reads instead
of getting `access_denied`. It does not affect project **membership**, and the
dashboard's project list (and the zero-project welcome gate) is built
exclusively from `loadUserProfile()` in `gateway/src/config-cache.js`, which
reads only the DynamoDB `quorum-user-projects` membership table. `is_public`
is never consulted there, and `ProjectSelector.jsx` only ever renders projects
the signed-in user is already a member of. There is currently no path for a
public-but-not-a-member project to become visible to anyone who doesn't
already know its `group_id`.

Separately: two UI controls on the two guest-accessible pages
(`Knowledge.jsx`, `Stats.jsx`) have no membership check, so once a guest *can*
reach a public project they would see action buttons that the backend would
403 on click.

## Goal

A random authenticated (GitHub OAuth) user, with zero project memberships,
sees every `is_public: true` project in their project list/selector and can
browse it read-only. No membership row is created. No write affordance
(create entry, bump, promote/supersede/deprecate, config edit, admin) is
reachable or visible to them.

## Already in place (no changes needed)

Significant RBAC plumbing already exists in `quorum-dash` and just needs a
non-member to actually reach a project for it to engage correctly:

- `isGuest` (`AuthContext.jsx:505`) is already computed as
  `!currentProjectData || currentProjectData.role === null`.
- `MemberRoute` (`App.jsx`) already redirects guests away from
  `/pending`, `/deviations`, `/portfolio`, `/audit`, `/config`, `/status`.
- `AdminRoute` already gates `/admin` on `user.is_admin`.
- `Sidebar.jsx` already hides all non-`guestOk` nav links for guests.
- Gateway's `requireMembership` middleware already 403s every mutating
  (`POST`/`PATCH`/`PUT`/`DELETE`) request when `req.user.role == null` and the
  caller isn't a platform admin.

None of this required a membership row — it all keys off `role === null`,
which is exactly the state a non-member viewing a public project already has
today (`verify-jwt.js` sets `role: null` for them once `access_denied` is
false). The only gap is that nothing currently puts such a user in a position
to *select* a public project in the first place.

## Architecture & Data Flow

```
PostgreSQL q_projects
  + is_public BOOLEAN NOT NULL DEFAULT FALSE   (mirrors existing is_global column)
  + idx_qp_is_public partial index WHERE is_public = TRUE

Sync points (mirror existing is_global handling, same 3 call sites):
  POST /config/upload        (gateway/src/routes/config.js)
  PUT  /config/:projectId    (gateway/src/routes/config.js)
  syncAllConfigs()           (gateway/src/routes/sync.js)

New route:
  GET /api/public-projects   (gateway, authenticated, no X-Quorum-Project
                               header required — same shape as GET /api/globals)
  → SELECT group_id, display_name, owner, q_project_id
    FROM q_projects WHERE is_public = TRUE

Dashboard login flow (AuthContext.jsx completeOAuth()):
  Promise.all([
    fetchProfile(sub, jwt),        // GET /user/profile/:sub — membership, unchanged
    fetchPublicProjects(jwt),      // GET /api/public-projects — new
  ])
  → merge into one array, dedupe by group_id (membership entry wins on conflict)
  → public-only entries get { role: null, base_confidence: 0.5, is_owner: false, is_public: true }
  → feed merged array into the EXISTING zero/one/many-project branching, unchanged
```

Because the existing branching logic in `completeOAuth()` already handles
zero/one/many projects, no behavioral logic changes there — only the input
array changes. A guest whose only available "project" is one public project
auto-selects it exactly like today's single-membership auto-select, lands
with `role: null`, and `isGuest` becomes `true` automatically — which already
cascades correctly into every guard listed above.

`loadUserProfile()` and `GET /user/profile/:username` are **not** modified.
Keeping membership semantics untouched avoids a privacy regression: that
endpoint's `sharesProject` check (`user.js`) uses `profile.projects` to decide
whether two users may view each other's profile. If public projects were
merged in at that layer, any two strangers who both viewed the same public
project would incorrectly count as "sharing a project."

## Backend Changes

1. **Migration** (`helm/quorum/files/init-db.sql`): add
   `is_public BOOLEAN NOT NULL DEFAULT FALSE` to the `q_projects` table
   definition, an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration guard,
   and `idx_qp_is_public ON q_projects (is_public) WHERE is_public = TRUE` —
   identical pattern to the existing `is_global` block.
2. **`gateway/src/routes/config.js`**: at both `isGlobal: config.is_global ?? false`
   call sites (project-create insert and the existing-project re-affirmation
   path), add `isPublic: config.is_public ?? false` / the matching
   `UPDATE q_projects SET is_public = true WHERE group_id = $1` re-affirmation.
3. **`gateway/src/routes/sync.js`**: in `syncAllConfigs()`, alongside the
   existing `UPDATE q_projects SET is_global = true WHERE group_id = ANY($1)`
   batch update, add the equivalent for `is_public`.
4. **New route** `GET /api/public-projects` in `gateway/src/routes/dashboard.js`
   (or a new small route file, following whichever the `/api/globals` handler
   uses) — authenticated via standard JWT middleware, no project-scope
   requirement, returns all `is_public = TRUE` projects.

## Frontend Changes

1. **`quorum-dash/src/context/AuthContext.jsx`**: add a `fetchPublicProjects`
   API call; in `completeOAuth()`, fetch it in parallel with the existing
   profile fetch, merge/dedupe as described above, pass the merged array into
   the existing branching.
2. **`quorum-dash/src/pages/Knowledge.jsx`**: wrap the "Create entry" button
   and form with `!isGuest`.
3. **`quorum-dash/src/components/stats/BumpButton.jsx`** (or its caller,
   `DecayingKnowledge.jsx`): wrap with `!isGuest`.
4. Audit pass over `Knowledge.jsx`, `KnowledgeDetail.jsx`, `Graph.jsx`,
   `Stats.jsx` for any other mutating control missing an `isGuest` (or
   equivalent role) check before considering this complete.
5. Optionally: a small visual marker (e.g. "Public" badge) on public-only
   entries in `ProjectSelector.jsx`, since the merged-list UX was chosen over
   a separate section — using the `is_public` flag added to those entries.

## Testing

- Gateway unit tests for the `is_public` sync logic in `config.js`/`sync.js`,
  mirroring existing `is_global` coverage.
- New gateway unit tests for `GET /api/public-projects`.
- New E2E API sub-scenario (extends `19-auth-lifecycle.spec.js` and/or
  `05-rbac-boundary.spec.js`): a fresh, non-member authenticated user sees a
  public project in `GET /api/public-projects` / their merged list, and gets
  403 (`not_a_member`) on any mutating route against it.
- New E2E browser sub-scenario in `quorum-dash`: a guest session never renders
  the Bump button or Create-entry button; direct navigation to `/config`
  (etc.) redirects away — this last assertion should already pass today via
  `MemberRoute` and serves as regression protection going forward.
- Both gateway and quorum-mcp vendor `config/schema.js`, but `is_public` is
  already present in both copies (v0.4) — no cross-repo schema sync needed
  for this change; it's gateway/dashboard-only.

## Out of Scope

- Hierarchy/`global_scope`-style filtering of public projects. Any
  `is_public` project is visible to every authenticated user, with no
  org-tier scoping (unlike `is_global` catalogs, which already have
  `global_scope`).
- A "browse projects you're not in" search UI beyond the merged project list.
- Retroactively backfilling `is_public` for projects whose config predates
  this column — handled automatically on next config sync, same as how
  `is_global` already self-heals (`config.js`'s existing-project
  re-affirmation path, and `syncAllConfigs()`'s batch update).
