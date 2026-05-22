# J13 — Config Management & Governance

**Scenario ID:** S-13
**Weight:** 16 (16 raw leaves × F1)
**Blast radius:** 1.7% of suite — Low
**Frequency tier:** F1 (one-time / rare — config changes are infrequent lifecycle events)
**Spec file:** `tests/e2e/scenarios/13-config-governance.spec.js`

---

## What It Covers

Config upload idempotency, schema validation (including `global_scope` regex), ownership transfer,
role updates, and the `globals` validation rules in `POST /sync/configs`.

**Roles:** `test-pe` (owner), `test-architect` (receives ownership transfer)
**Touches:** `POST /config/upload`, `POST /config/validate`, `POST /config/transfer-ownership`, `POST /config/update-role`, `POST /sync/configs`
**Automated:** Yes — API

---

## Setup

No prior state. Uses unique `group_id` suffixed with scenario ID to avoid conflicts with other scenarios.

---

## Steps

### Part A — Config validation (no auth required)

1. `POST /config/validate` with valid config JSON:
   ```json
   {
     "group_id": "validate-test",
     "project": "Validation Test",
     "owner": "test-pe",
     "members": [{ "github_username": "test-pe", "role": "principal_architect", "base_confidence": 0.9, "team": "platform" }],
     "domains": { "security": {}, "auth": {} }
   }
   ```
   - Assert: `200`, `valid: true`

2. `POST /config/validate` with missing required field (`group_id` absent):
   - Assert: `400`, `valid: false`, `errors` array contains field-level error for `group_id`

3. `POST /config/validate` with `is_global: true` and invalid `global_scope` format:
   ```json
   { ..., "is_global": true, "global_scope": "invalid-format-not-matching-regex" }
   ```
   - Assert: `400`, `errors` array contains error for `global_scope` (must match `^(org|division:[a-z0-9-]+|department:[a-z0-9-]+)$`)

4. `POST /config/validate` with valid `global_scope: "division:payments-division"`:
   - Assert: `200`, `valid: true`

---

### Part B — Upload idempotency

5. Upload a fresh config via `POST /config/upload` as `test-pe` (bootstrap auth — PE listed in members):
   - Assert: `201`, `project_id` matches `group_id`

6. Same `POST /config/upload` call again (same config, same key in S3):
   - Assert: `409` with `error: "already_onboarded"`
   - Assert: response body includes `q_project_id` for the existing project

---

### Part C — Ownership transfer

7. `POST /config/transfer-ownership` as `test-pe`:
   ```json
   { "to": "test-architect", "reason": "Architecture team taking ownership after platform migration" }
   ```
   - Assert: `200`, `{ ok: true, from: "test-pe", to: "test-architect" }`

8. Verify transfer persisted:
   - `GET /config/:projectId` (or check DDB) — `owner` is now `test-architect`
   - Assert: `test-architect` now has `is_owner: true` in their project profile
   - Assert: `test-pe` now has `is_owner: false`

---

### Part D — Role update

9. `POST /config/update-role` as `test-architect` (now owner):
   ```json
   { "github_username": "test-engineer", "role": "senior_engineer", "reason": "Promoted after successful platform project delivery" }
   ```
   - Assert: `200`, `{ ok: true, github_username: "test-engineer", role: "senior_engineer" }`

10. Verify role updated:
    - Make a request with `test-engineer` JWT
    - Assert: `req.user.role` resolves to `"senior_engineer"` (Redis profile cache invalidated and refreshed)

---

### Part E — globals validation in sync

11. `POST /sync/configs` with a project config whose `globals` array references a non-global project:
    ```json
    { "group_id": "test-project-sync", ..., "globals": ["non-global-project-id"] }
    ```
    - Assert: `200` (sync succeeds — not a hard error)
    - Assert: response contains `globals_warnings` array with a warning about the non-global reference

12. `POST /sync/configs` with a config that self-references its own `group_id` in `globals`:
    ```json
    { "group_id": "self-ref-test", ..., "globals": ["self-ref-test"] }
    ```
    - Assert: `400` with `error: "self_reference_in_globals"`

---

## Pass Criteria

- [ ] Config validation works without authentication
- [ ] Missing required field (`group_id`) fails validation with field-level error
- [ ] Invalid `global_scope` format fails Zod regex validation
- [ ] Valid `global_scope: "division:..."` passes validation
- [ ] Duplicate upload → `409 already_onboarded`
- [ ] Ownership transfer changes owner in S3 config, DDB profile, and Redis cache
- [ ] Role update reflects on next authenticated request (cache invalidated)
- [ ] Non-global project in `globals` → `200` with `globals_warnings` (not a hard error)
- [ ] `globals` self-reference → `400 self_reference_in_globals`
