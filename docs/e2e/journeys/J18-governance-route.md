# J18 — Governance Route: Direct Coverage

**Scenario ID:** S-18
**Weight:** 18 (12 raw leaves × F1.5)
**Blast radius:** 1.7% of suite
**Frequency tier:** F1.5 (periodic — LLM-backed routes are exercised indirectly by the conflict pipeline;
direct coverage runs on scheduled compliance and regression runs)
**Spec file:** `tests/e2e/scenarios/18-governance-route.spec.js`

---

## What It Covers

Direct HTTP testing of the three LLM-backed routes in `routes/governance.js`. These routes are
called internally by the conflict detection pipeline (via `remember.js` → `detectConflict()` →
`governance/conflict.js`) but are never directly tested in any other E2E scenario. With a mock
OpenAI server returning controlled fixtures, all three routes are fully testable without LLM cost.

**Why direct coverage matters:** a change to input validation, response shaping, or sanitization
in `governance.js` would not be caught by the conflict pipeline tests — those tests mock at the
HTTP response layer, not at the OpenAI call layer. Direct coverage catches regressions in the
route-level contract.

**Roles:** `test-pe` (authenticated — all governance routes require a valid JWT)
**Touches:** `POST /governance/detect-conflict`, `POST /governance/enrich`, `POST /governance/extract`
**Automated:** Yes — API (requires mock OpenAI server returning controlled fixtures)

---

## Setup

Mock OpenAI server must be running and configured to return the following fixtures:

```javascript
// detect-conflict fixture — always returns conflict detected
{ choices: [{ message: { content: JSON.stringify({
  conflict_detected: true,
  conflict_brief: "Fundamental disagreement on session state: stateless JWT vs stateful Redis sessions"
}) } }] }

// enrich fixture
{ choices: [{ message: { content: JSON.stringify({
  analysis: "The existing entry favours stateless JWT sessions for scalability; the incoming entry argues for Redis-backed sessions for revocation control. Both are valid architectural concerns with different trade-off profiles.",
  risks_if_approved: [
    "Cannot invalidate tokens before expiry — security risk if JWT is leaked",
    "Forces Redis operational dependency in all services that need auth",
    "Breaks existing stateless deployments that rely on JWT scalability guarantees"
  ],
  questions_for_reviewer: [
    "Has the team evaluated short-lived JWTs (15 min) with refresh token rotation as a middle ground?",
    "Are there specific regulatory requirements that mandate session revocation capability?"
  ]
}) } }] }

// extract fixture
{ choices: [{ message: { content: JSON.stringify({
  items: [
    { topic: "reliability", key: "rate-limiter-algorithm", content: "Use sliding window algorithm for rate limiting. One counter per service per endpoint.", entity_type: "Pattern", confidence: 0.82, mode: "remember" },
    { topic: "reliability", key: "rate-limiter-storage", content: "Store rate limit counters in Redis. Max 100 req/min per endpoint.", entity_type: "Decision", confidence: 0.75, mode: "remember" }
  ]
}) } }] }
```

`test-pe` JWT authenticated against `quorum-test-project`.

---

## Steps

### Part A — `POST /governance/detect-conflict` Input Validation

1. Call with missing `existing` field:
   ```json
   { "incoming": { "content": "Use Redis for session storage", "author": "test-engineer", "confidence": 0.65 } }
   ```
   - Assert: `422` with error describing the missing field

2. Call with missing `incoming` field:
   ```json
   { "existing": { "content": "Use JWT sessions", "author": "test-pe", "confidence": 0.80 } }
   ```
   - Assert: `422`

3. Call with both fields present (happy path — mock OpenAI returns controlled fixture):
   ```json
   {
     "existing": {
       "content": "Use JWT sessions. Stateless, no server-side state. Tokens are self-contained.",
       "author": "test-pe",
       "confidence": 0.80
     },
     "incoming": {
       "content": "Use Redis-backed sessions. JWT cannot be revoked — security risk.",
       "author": "test-engineer",
       "confidence": 0.65
     }
   }
   ```
   - Assert: `200`
   - Assert: `conflict_detected: true` (or `conflict_score` > threshold — format dependent on implementation)
   - Assert: `conflict_brief` is a non-empty string

---

### Part B — `POST /governance/enrich` Input Validation

4. Call with missing `conflict_reason`:
   ```json
   {
     "existing": { "content": "Use JWT sessions.", "author": "test-pe", "confidence": 0.80 },
     "incoming": { "content": "Use Redis sessions.", "author": "test-engineer", "confidence": 0.65 }
   }
   ```
   - Assert: `422`

5. Call with all required fields present (happy path):
   ```json
   {
     "existing": { "content": "Use JWT sessions.", "author": "test-pe", "confidence": 0.80 },
     "incoming": { "content": "Use Redis sessions.", "author": "test-engineer", "confidence": 0.65 },
     "conflict_reason": "Both specify session strategy for the same service context"
   }
   ```
   - Assert: `200`
   - Assert: response has `analysis` field — non-empty string (> 20 chars)
   - Assert: `risks_if_approved` is an Array
   - Assert: `risks_if_approved.length >= 2 && risks_if_approved.length <= 4`
   - Assert: every item in `risks_if_approved` is a non-empty string
   - Assert: `questions_for_reviewer` is an Array
   - Assert: `questions_for_reviewer.length >= 2 && questions_for_reviewer.length <= 3`
   - Assert: every item in `questions_for_reviewer` is a non-empty string

---

### Part C — `POST /governance/extract` Input Validation + Response Shape

6. Call with missing `task_summary`:
   ```json
   {}
   ```
   - Assert: `422`

7. Call with `task_summary` present (happy path):
   ```json
   {
     "task_summary": "Build a distributed rate limiter using Redis. One counter per service per endpoint. Use sliding window algorithm. Maximum 100 requests per minute per endpoint."
   }
   ```
   - Assert: `200`
   - Assert: response has `items` array (not empty — at least 1 item)
   - For each item in `items`:
     - Assert: `topic` is a non-empty string
     - Assert: `key` matches `/^[a-z0-9-]+$/` (kebab-case — no spaces, no uppercase)
     - Assert: `content` is a non-empty string (> 10 chars)
     - Assert: `entity_type` is a non-empty string
     - Assert: `confidence` is a number between 0 and 1 inclusive
     - Assert: `mode` is one of `["remember", "update", "deprecate"]`

---

### Part D — Input Sanitization: `sanitizeForPrompt` Truncation

> `sanitizeForPrompt()` normalizes smart quotes, escapes backticks, and caps content at 2000
> characters before LLM interpolation. Overlong inputs must not cause errors — they must be
> silently truncated. This is a prompt-injection boundary condition.

8. Call `POST /governance/detect-conflict` with `existing.content` of 2500 characters
   (fill with a repeated ASCII string — `"A".repeat(2500)`):
   ```json
   {
     "existing": { "content": "<2500-char string>", "author": "test-pe", "confidence": 0.80 },
     "incoming": { "content": "Normal incoming content.", "author": "test-engineer", "confidence": 0.65 }
   }
   ```
   - Assert: HTTP 200 (does not error — gateway handles overlong input gracefully)
   - Assert: `conflict_detected` field present in response (mock OpenAI received a truncated prompt and responded normally)
   - Assert: response time < 5 seconds (truncation does not cause timeout)

9. Call `POST /governance/extract` with `task_summary` of 2500 characters:
   ```json
   { "task_summary": "<2500-char string>" }
   ```
   - Assert: HTTP 200
   - Assert: `items` array present (extraction succeeded on truncated input)

---

## Pass Criteria

- [ ] `detect-conflict` missing `existing` → `422`
- [ ] `detect-conflict` missing `incoming` → `422`
- [ ] `detect-conflict` happy path → `200`, `conflict_brief` is a non-empty string
- [ ] `enrich` missing `conflict_reason` → `422`
- [ ] `enrich` happy path → `200`, `analysis` (string) + `risks_if_approved` + `questions_for_reviewer` all present
- [ ] `enrich` `risks_if_approved`: 2–4 items, all non-empty strings
- [ ] `enrich` `questions_for_reviewer`: 2–3 items, all non-empty strings
- [ ] `extract` missing `task_summary` → `422`
- [ ] `extract` happy path → `200`, `items` array is non-empty
- [ ] Each `extract` item has all 6 fields: `topic`, `key`, `content`, `entity_type`, `confidence`, `mode`
- [ ] Each `key` is kebab-case: matches `/^[a-z0-9-]+$/`
- [ ] Each `confidence` is a number in [0, 1]
- [ ] Each `mode` is one of `["remember", "update", "deprecate"]`
- [ ] 2500-char input to `detect-conflict` → `200` (no error, truncation handled)
- [ ] 2500-char input to `extract` → `200` (no error, `items` present)

---

## Teardown

No persistent state created. All calls use mock OpenAI. No knowledge entries written.

---

## Notes

**Why these routes are not tested as part of the conflict pipeline integration tests:**
The conflict pipeline tests (S-02) mock at the HTTP response layer — the mock OpenAI is configured
to return a fixed response for any prompt. The pipeline tests validate the flow (write → detect →
pending queue → PE reviews), not the shape of what the LLM-backed routes produce. This scenario
tests the route contracts that the pipeline depends on.

**Mock OpenAI server requirement:** this scenario requires the mock OpenAI server from
`tests/mocks/openai-server.js` to be running and returning the fixtures defined in Setup.
Without a mock, tests will hit the real OpenAI API — slow, costly, and non-deterministic.

---

## Related Scenarios

- **S-02.2** (Conflict detection) — tests the pipeline that calls these routes internally
- **S-17** (Conflict edge cases) — enrichment shape also asserted via the pending conflict record
