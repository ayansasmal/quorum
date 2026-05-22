# J08 — Confidence Endorsement (Bump)

**Scenario ID:** S-08
**Weight:** 30 (15 raw leaves × F2)
**Blast radius:** 3.2% of suite
**Frequency tier:** F2 (weekly — bumps occur when teams endorse established knowledge)
**Spec file:** `tests/e2e/scenarios/08-confidence-bump.spec.js`

---

## What It Covers

Role-weighted confidence endorsement, the 7-day cooldown per user per entry, the cap at
`starting_confidence` (confidence can never exceed its original value), and the UI update
in the Knowledge browser when confidence changes.

**Roles:** `test-engineer`, `test-architect`, `test-pe`
**Touches:** `POST /api/bump/:topic/:key`, `GET /pg/versions/:topic/:key`, `/knowledge` page
**Automated:** Yes — API + Playwright

---

## Role Weight Reference

| Role | `BUMP_ROLE_WEIGHT` | Delta (base × weight) |
|------|-------------------|-----------------------|
| engineer | 0.50 | 0.05 × 0.50 = 0.0250 |
| senior_engineer | 0.70 | 0.05 × 0.70 = 0.0350 |
| architect | 0.85 | 0.05 × 0.85 = 0.0425 |
| principal_architect | 1.00 | 0.05 × 1.00 = 0.0500 |

---

## Setup

Seed entry via `test-pe`:
- `topic: "auth"`, `key: "session-timeout"`, `content: "Sessions expire after 30 min of inactivity"`
- `confidence: 0.80`, `starting_confidence: 0.80` (at cap from the start)

---

## Steps

1. `POST /api/bump/auth/session-timeout` as `test-engineer`
   - Engineer delta = 0.0250
   - But `confidence (0.80) + delta (0.025) = 0.825 > starting_confidence (0.80)`
   - Assert: `confidence_after: 0.80` (capped — cannot exceed starting_confidence)
   - Assert: `capped: true` in response

2. Decay entry confidence to 0.70 via direct DB update (simulates time-based decay):
   ```sql
   UPDATE knowledge_versions SET confidence = 0.70
   WHERE topic = 'auth' AND key = 'session-timeout' AND status = 'ACTIVE'
   ```

3. `POST /api/bump/auth/session-timeout` as `test-engineer`
   - 0.70 + 0.025 = 0.725, which is < starting_confidence (0.80) → not capped
   - Assert: `confidence_after: 0.7250`
   - Assert: `capped: false`

4. Second bump as same engineer immediately after:
   - Assert: `429 Too Many Requests` with `error: "cooldown_active"`
   - Assert: `next_bump_allowed` timestamp present in response (approximately 7 days from now)

5. `POST /api/bump/auth/session-timeout` as `test-architect` (different user — no cooldown):
   - Architect delta = 0.0425
   - 0.7250 + 0.0425 = 0.7675
   - Assert: `confidence_after: 0.7675`
   - Different user's cooldown is independent — no 429

6. Navigate to `/knowledge` as any authenticated user
   - Assert: `auth:session-timeout` confidence bar reflects `0.7675`

7. Simulate engineer cooldown expiry via DB update (set `bumped_at` to 8 days ago):
   ```sql
   UPDATE knowledge_versions SET bumped_at = NOW() - INTERVAL '8 days'
   WHERE topic = 'auth' AND key = 'session-timeout'
   AND bumped_by = 'test-engineer'
   ```

8. `POST /api/bump/auth/session-timeout` as `test-engineer` again
   - Assert: `200` (cooldown expired, bump succeeds)
   - Assert: confidence increases by 0.025

---

## Pass Criteria

- [ ] Bump delta = `0.05 × BUMP_ROLE_WEIGHT[role]` for each role
- [ ] Confidence capped at `starting_confidence` — never exceeds original value
- [ ] Same user bumping immediately after → `429 cooldown_active` with `next_bump_allowed`
- [ ] Different users have independent cooldowns — architect can bump while engineer is in cooldown
- [ ] Confidence bar in Knowledge browser updates to reflect new value after bump
- [ ] After cooldown expiry (simulated via DB), bump succeeds again
