# J22 — Portfolio Intelligence UI

**Scenario:** S-22  
**Pillar:** Observability 🟡  
**OwnScore:** 66 | **FailureCost:** 141 (correlates S-07 conformance scoring)  
**Leaf count:** 22 | **F:** 2 | **W:** 44  
**C:** 1.0 | **D:** 1.5  
**Gate:** 🟡 (score-gated)

---

## Product Story

A principal architect opens the Portfolio page to get a birds-eye view of conformance health across all projects their platform team governs. They need to see at a glance: how many projects are CERTIFIED, what the org-level score is, and which projects are dragging the average down.

They use the search box to find a specific project, then toggle the status filter to UNCERTIFIED-only to prioritise remediation. The page must be responsive to filter changes without a full reload and must accurately reflect the data returned by `GET /api/portfolio`.

The journey validates two things in parallel:
1. **The API** correctly enforces the executive/PA role gate, returns the right shape, and handles edge cases (empty hierarchy filter, all-UNCERTIFIED rollup).
2. **The UI** correctly renders the rollup banner, table rows, and responds to search and status filter interactions.

---

## Validated Sub-Scenarios

### S-22.1 — Portfolio Role Gate (API)
| Step | Assertion | Type |
|------|-----------|------|
| engineer → GET /api/portfolio | 403 | Negative |
| architect → GET /api/portfolio | 403 | Negative |
| principal_architect → GET /api/portfolio | 200 | Happy path |
| director → GET /api/portfolio | 200 | Happy path |

### S-22.2 — Response Shape (API)
| Step | Assertion | Type |
|------|-----------|------|
| projects is array | typeof check | Shape |
| each project has 9 required fields | field presence | Shape |
| rollup has score/status/certified_count/uncertified_count | field presence | Shape |
| project.status is CERTIFIED or UNCERTIFIED | enum validation | Shape |

### S-22.3 — UNCERTIFIED Rollup (API)
Uses `quorum-test-isolated-project` (no globals → permanently UNCERTIFIED).

| Step | Assertion | Type |
|------|-----------|------|
| isolated project → 200 | status check | Happy path |
| isolated project.status === UNCERTIFIED | conformance state | Happy path |
| isolated project.score === null | null score for uncertified | Happy path |

### S-22.4 — node_id Hierarchy Filter (API)
| Step | Assertion | Type |
|------|-----------|------|
| ?node_id=nonexistent-node-xyz → projects: [] | empty filter | Negative |
| ?node_id=nonexistent-node-xyz → rollup: null | null rollup when empty | Edge case |

### S-22.5 — Page Renders (Browser)
| Step | Assertion | Type |
|------|-----------|------|
| portfolio-rollup testid visible | banner render | Happy path |
| portfolio-score-badge testid visible | score display | Happy path |
| portfolio-certified-count + portfolio-uncertified-count visible | stat counters | Happy path |

### S-22.6 — Table Rows (Browser)
| Step | Assertion | Type |
|------|-----------|------|
| portfolio-table testid visible | table render | Happy path |
| at least one portfolio-row testid visible | data loaded | Happy path |

### S-22.7 — Search Filter (Browser)
| Step | Assertion | Type |
|------|-----------|------|
| fill search → filtered row count ≤ original | filter reduces rows | Interaction |
| clear search → row count returns to original | filter removed | Interaction |

### S-22.8 — Status Filter (Browser)
| Step | Assertion | Type |
|------|-----------|------|
| select UNCERTIFIED → all rows contain "UNCERTIFIED" | filter correctness | Interaction |
| select All → row count returns to original | filter reset | Interaction |

---

## Dependencies

- `GET /api/portfolio` — `gateway/src/routes/dashboard.js`
- `getConformanceScore()` / `getPortfolioScores()` — `gateway/src/shared/graph/queries.js`
- `Portfolio.jsx` — `dashboard/src/pages/Portfolio.jsx`
- `usePortfolio()` — `dashboard/src/api/conformance.js`
- Fixtures: `quorum-test-project`, `quorum-test-catalog`, `quorum-test-isolated-project`

## Correlation

S-07 (conformance scoring) is the root. If `getConformanceScore` breaks, both S-07 and S-22 fail. FailureCost = OwnScore(66) + OwnScore(S-07: 75) = 141.

## Closes

GAP-028 — Portfolio full-page UI had no browser E2E tests. S-22.5–22.8 provide coverage.
