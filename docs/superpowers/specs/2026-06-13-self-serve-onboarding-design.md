# Self-Serve Onboarding — Design Spec

**Date:** 2026-06-13
**Status:** Reviewed — §7 decisions resolved; ready for implementation planning
**Author:** ayansasmal
**Scope:** `quorum` (gateway) · `quorum-dash` (dashboard) · `quorum-mcp` (MCP server)

---

## 1. Philosophy

> **The library brings the building and the fittings — framework, shelves, cupboards, tables, chairs. Every book is carried in.**

Quorum provides structure only. At first boot it seeds exactly **one** thing: the list of *initial admins* (the librarian's badge — who is allowed to run the building). Everything else — projects, hierarchy labels, global catalogs, members, knowledge — is brought in by users through self-service.

Corollaries the design must honour:

- **Login = GitHub, full stop.** Anyone with a valid GitHub identity can authenticate. Admins *help*, they do not gatekeep. If you can log in, you can use Quorum.
- **Self-serve to the max.** A brand-new engineer who has never touched Quorum can onboard their own project — of any size — without asking anyone. Onboarding is via the **MCP** (`config_upload`). The dashboard is for operating *already-onboarded* projects (plus admin management — see §4.4).
- **Anyone can create a global catalog.** No admin gate. A global standard becomes *applicable* only when projects link it (`globals: [...]`). The check on a bad standard is **governance, not gatekeeping** — global writes land as DRAFT and need a *second* PA to promote (existing S-11.1 rule).
- **Quorum is a graveyard of knowledge, by design.** Nothing is hard-deleted. Old knowledge stays — just *unreliable* (confidence decays). Unused global catalogs decay faster (Initiative II). Users can **bump** decayed-but-non-conflicting knowledge to restore its relevance (existing `POST /api/bump`, role-weighted, 7-day cooldown, capped at starting confidence).
- **Hierarchy is label-only.** Org / division / department are *grouping definitions* projects point at. Quorum stores no members and takes no action at those tiers.

---

## 2. Goals / Non-Goals

### Goals
1. A GitHub-authenticated user with **zero projects** can obtain a JWT and reach the dashboard in a welcoming state.
2. That same user can self-serve onboard their first project via the MCP (`authenticate` → `config_upload`) with **no pre-existing membership and no admin involvement**.
3. The gateway seeds **initial admins only** at first boot, idempotently, across every deployment target (local / Helm / Crossplane).
4. Admins can **add and update admins from the dashboard** (no IaC edit, no re-seed).

### Non-Goals (named so they are not silently pulled in)
- **Initiative II — usage-driven global decay** (adoption-weighted decay rate). Separate spec; depends on this one shipping first.
- A **dashboard project-onboarding form** — onboarding is MCP-only by decision.
- **Catalog-entry seeding at boot** — knowledge is carried in via MCP.
- **Hierarchy member seeding** — hierarchy tiers are label-only.

---

## 3. The Deadlock Being Removed

Three gates re-check project membership **at login time**, contradicting the slim-JWT design (`{ sub, is_admin }` = "who you are"; project scope arrives per-request via `X-Quorum-Project` and is enforced by `verify-jwt`). They create a bootstrap deadlock: you need a project to authenticate, but you need to authenticate to create a project.

| # | Gate | Location | Current behaviour |
|---|------|----------|-------------------|
| 1 | PAT / MCP exchange | [auth.js:87-115](../../../gateway/src/routes/auth.js#L87-L115) | `project_id` required; `findMember` → 403 — **before** `isPlatformAdmin` is even consulted |
| 2 | Browser OAuth callback | [mcp-oauth.js:271-272](../../../gateway/src/routes/mcp-oauth.js#L271-L272) | `projects.length === 0` → redirect `?error=no_projects`; JWT never minted |
| 3 | Dashboard client | [AuthContext.jsx:331-334](../../../../quorum-dash/src/context/AuthContext.jsx#L331-L334) | zero projects → error + discard JWT |

**Key safety property preserved:** the per-request guard is untouched. `verify-jwt` still computes `access_denied` for non-members of private projects ([verify-jwt.js:97-118](../../../gateway/src/middleware/verify-jwt.js#L97-L118)), and `/pg/*` + `/api/*` still reject on it. We remove the **front-door ownership check**, not the **per-shelf** one.

---

## 4. Design — Initiative I

### 4.1 Auth decoupling (gateway)

- **PAT/MCP path — `/auth/token`:** make `project_id` **optional**. Absent → verify GitHub token → `is_admin = isPlatformAdmin(login)` → issue `{ sub, is_admin }`; no `findMember`, no 403. Present → still issue the JWT regardless of membership; use the project only to enrich the response role, never to gate.
- **Browser OAuth callback — `mcp-oauth.js`:** remove the `projects.length === 0 → ?error=no_projects` redirect. Zero projects → mint the JWT, land on the welcome screen (§4.3).
- **MCP `authenticate` tool (quorum-mcp):** relax its schema so `project_id` is optional, enabling cold-start `authenticate` → `config_upload`.

### 4.2 Admin boot-seed (gateway startup)

- On startup, **if `configs/.quorum` is absent** in S3 **and** `QUORUM_FIRST_ADMIN` is set → write it once. Idempotent: never overwrites an existing file. Accept a **comma-separated list** for multiple initial admins.
- Implemented as a single `ensureAdminConfig()` invoked from `server.js` startup, co-located with `isPlatformAdmin` / `saveAdminConfig` in [config-cache.js](../../../gateway/src/config-cache.js). One portable path for every environment — supersedes the LocalStack-only seeding in `init-localstack.sh`.
- This is the **only** seeded artefact.

### 4.3 Dashboard zero-projects welcome (no onboarding form)

- [AuthContext.jsx:331-334](../../../../quorum-dash/src/context/AuthContext.jsx#L331-L334): zero projects → **keep the JWT**, enter `authenticated` with `activeProject = null` (not error, not discard).
- A welcome/empty screen: *"You're in — no projects yet. Onboard one from your MCP client (`quorum config_upload`)."* No creation form.

### 4.4 Admin management from the dashboard (NEW)

- The dashboard **Admin** panel ([Admin.jsx](../../../../quorum-dash/src/pages/Admin.jsx)) must let an admin **add and update admins**, backed by the existing `POST /admin/users` / `/admin/config` ([admin.js](../../../gateway/src/routes/admin.js)).
- Guard rails (see §5): admin-gated; **cannot remove the last admin** (§5 G3).
- **Propagation (§5 G2 decision):** `is_admin` stays in the JWT. A newly-granted admin must **re-authenticate** to receive powers (their current token has `is_admin: false`); a revoked admin retains powers until their token expires (≤1 h). Accepted given the short TTL.

---

## 5. Security Ideation — Gap Analysis

Opening authentication widens the trust boundary from "project members" to "anyone with a GitHub account." Each gap below is rated by **severity** and tagged **NEW** (introduced/amplified by this change) or **EXISTING**.

### G1 — Public-project write spam · **P1 · AMPLIFIED** · *grounded* · **RESOLVED**
Any authenticated user can `POST` a **DRAFT** to **any `is_public` project** they are not a member of. Verified: [verify-jwt.js:107](../../../gateway/src/middleware/verify-jwt.js#L107) leaves `access_denied = false` for public projects; [pg.js:134](../../../gateway/src/routes/pg.js#L134) only blocks on `access_denied`; status derivation ([pg.js:537-538](../../../gateway/src/routes/pg.js#L537-L538)) makes a `role: null` writer a DRAFT rather than rejecting them. Inert (DRAFTs need a 2nd-PA promote to affect ACTIVE/conformance) but a spam + storage vector once auth is open.
**RESOLVED:** `is_public` is **read-only** for non-members. Add an explicit membership check on every write path (`/pg/versions`, `/api/knowledge`, deviations): reject a `role === null` writer even when `!access_denied`. **Reads** of public projects remain open to any authenticated user.

### G2 — Stale `is_admin` on revocation · **P1 · ACCEPTED RISK** · **RESOLVED**
`is_admin` is baked into the JWT at issuance.
**RESOLVED:** keep `is_admin` in the JWT (no per-request resolution). Consequence accepted: a newly-granted admin must **re-authenticate** to receive powers, and a revoked admin retains powers until their token expires (≤1 h TTL). Bounded by the short TTL; admin churn is expected to be rare. The zero-admin lockout case is covered separately by G3.

### G3 — Last-admin lockout / self-demotion · **P1 · NEW** · **RESOLVED**
Dashboard admin management could remove the final admin (or an admin demotes themselves), leaving the building with no keys.
**RESOLVED:** the admin-removal path (`POST /admin/users` / `/admin/config`) **rejects removing the last remaining admin** — including self-demotion when you are the last admin — with `409 last_admin`. The guard counts admins in `configs/.quorum` after the proposed change and refuses to let the count reach zero. Adding admins is always allowed; only the final removal is blocked.

### G4 — Namespace squatting · **P2 · NEW** · **RESOLVED**
`config_upload` is first-come-first-served on `group_id` (409 on existing). Someone could register `<competitor>-standards` or a confusingly-named **global** catalog and block the legitimate owner.
**RESOLVED — accept-and-reclaim.** v1 keeps first-come-first-served with **no pre-reservation** and no namespace prefixing. Squatted or misappropriated names are reclaimed administratively via the existing `DELETE /admin/projects/:groupId`. Decay (Initiative II) retires *unused* squats over time; the admin reclaim path handles the rare contested *name* immediately. Tying names to a verified GitHub org is deferred to G6's enterprise-deployment knob.

### G5 — `QUORUM_SYNC_SECRET` blast radius · **P2 · EXISTING**
The sync-token path ([config.js:56-57](../../../gateway/src/routes/config.js#L56-L57)) bypasses all auth and can write **arbitrary** configs (any members/roles, `is_global`, etc.). A leak = full config-write compromise.
**Mitigations:** keep out of logs/chat (standing rule); rotate; restrict to the EventBridge sync principal. The boot-seed writes `configs/.quorum` via direct S3 (gateway IAM), **not** the sync secret — keep it that way.

### G6 — Open auth has no org boundary · **P3 · NEW (deployment knob)**
Anyone with *any* GitHub account authenticates. Intended for an open/demo instance; an enterprise deployment will want to restrict by GitHub org or email domain.
**Recommended (future, optional):** `QUORUM_GITHUB_ORG_ALLOWLIST` / allowed-domain env, enforced at GitHub-token verification. Out of scope for I; named so it is not forgotten.

### G7 — Resource exhaustion / project spam · **P3 · AMPLIFIED**
Open self-serve permits unbounded project/knowledge creation.
**Mitigations:** existing per-IP rate limiting; decay (Initiative II); admin archive. Acceptable now; revisit at scale.

### Non-gaps (verified safe)
- **Project-less JWT on a project-scoped route** → `project.js` returns 400 (no `X-Quorum-Project`); no data leak.
- **Private-project read by non-member** → `access_denied` 403 (unchanged).
- **"Anyone" ≠ anonymous** → `/auth/token` and the OAuth flow still verify a real GitHub token (`verifyGitHubToken`).
- **Self-declared `is_global` catalog** → entries still land DRAFT and require a 2nd-PA promote before they affect any linking project's conformance.

---

## 6. Testing Impact

- **Update:** E2E **S-19** (auth surface) + any test asserting `/auth/token` 403-on-non-member or `?error=no_projects`.
- **New:** `/auth/token` with no `project_id` → 200 slim JWT · OAuth callback zero-projects → JWT (not error) · `ensureAdminConfig` idempotency · dashboard zero-projects welcome state · MCP cold-start `authenticate` → `config_upload` · **G1** public-project write rejected for `role === null` (read-only enforcement), public read still 200 · **G3** last-admin removal / self-demotion → `409 last_admin` · **G2** newly-granted admin's existing token still `is_admin: false` until re-auth (no per-request resolution).

---

## 7. Resolved Decisions

All four security questions are settled; they are the source of truth for implementation planning.

| # | Decision | Resolution |
|---|----------|------------|
| **G1** | Public-project writes by non-members | **Read-only.** Public projects are readable by any authenticated user; **writes** require membership. Every write path rejects a `role === null` writer even when `!access_denied`. |
| **G2** | `is_admin` propagation | **Keep `is_admin` in the JWT** (no per-request resolution). A newly-granted admin re-authenticates to gain powers; a revoked admin keeps them until token expiry (≤1 h TTL). Risk accepted as bounded. |
| **G3** | Last-admin lockout | **Block the last removal.** `409 last_admin` on removing the final admin or self-demoting when you are the last. Adds are always allowed. |
| **G4** | Namespace squatting | **Accept-and-reclaim.** First-come-first-served, no pre-reservation; admins reclaim contested names via `DELETE /admin/projects/:groupId`; decay retires unused squats. |

---

## 8. Build Order
1. **Auth decoupling** (gateway) — the unlock; everything depends on it.
2. **Admin boot-seed** (gateway startup) — tiny, idempotent.
3. **Dashboard zero-projects welcome** + **admin management** (quorum-dash).
4. **Security hardening** per §5 decisions (G1/G2/G3 are in-scope for I; G4/G6/G7 noted).

> **Next spec:** Initiative II — Usage-Driven Global Decay (adoption-weighted decay of global catalogs).
