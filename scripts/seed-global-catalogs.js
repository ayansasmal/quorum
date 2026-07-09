#!/usr/bin/env node
/**
 * Seeds twelve global catalog projects with standard knowledge entries:
 *   security-knowledge     — security constraints and baseline controls
 *   best-practices         — cross-team engineering standards
 *   frontend-standards     — React / Next.js standards
 *   backend-standards      — Node.js API and service standards
 *   infra-standards        — CI/CD, deployment, and operations standards
 *   architecture-principles — SOA, KISS, DRY, SLAP, SRP, and other design principles
 *   owasp-standards        — OWASP Top 10 (2021) compliance mapping
 *   performance-standards  — latency, throughput, and resource-efficiency standards
 *   testing-standards      — test pyramid, isolation, and quality-gate standards
 *   observability-standards — tracing, metrics, alerting, and incident-response standards
 *   documentation-standards — ADRs, API docs, runbooks, and doc-freshness standards
 *   ai-systems-standards   — AI agent, MCP server, skill, and LLM-application standards
 *
 * Each catalog gets 10 ACTIVE entries (the minimum for UNCERTIFIED → CERTIFIED).
 * Entries are seeded via POST /pg/versions with an admin JWT, which bypasses the
 * global-catalog self-approval guard (S-11.1) and writes directly as ACTIVE.
 *
 * Usage:
 *   QUORUM_JWT=<admin-jwt> node scripts/seed-global-catalogs.js
 *
 * QUORUM_JWT must carry is_admin: true.
 * Get it from the dashboard: DevTools → Network → any /api/* request → Authorization header.
 *
 * Optional env vars:
 *   QUORUM_GATEWAY_URL=http://localhost:3001   (default)
 *   QUORUM_OWNER=ayansasmal                    (default)
 *   QUORUM_DRY_RUN=1                           (print catalog list without writing)
 *   QUORUM_CONFIG_ONLY=1                       (re-upload catalog configs only — skips
 *                                                seedEntries; use after changing a config
 *                                                field like is_public so re-runs don't
 *                                                insert duplicate ACTIVE versions)
 */

const GATEWAY     = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
const JWT         = process.env.QUORUM_JWT
const OWNER       = process.env.QUORUM_OWNER ?? 'ayansasmal'
const DRY_RUN     = process.env.QUORUM_DRY_RUN === '1'
const CONFIG_ONLY = process.env.QUORUM_CONFIG_ONLY === '1'

if (!DRY_RUN && !JWT) {
  console.error('[seed] QUORUM_JWT is required (must carry is_admin: true)')
  console.error('       DevTools → Network → any /api/* request → Authorization header (omit "Bearer ")')
  process.exit(1)
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function hdrs(projectId) {
  return {
    'Authorization':    `Bearer ${JWT}`,
    'Content-Type':     'application/json',
    'X-Quorum-Project': projectId,
  }
}

async function post(path, projectId, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method:  'POST',
    headers: hdrs(projectId),
    body:    JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function put(path, projectId, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method:  'PUT',
    headers: hdrs(projectId),
    body:    JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`PUT ${path} → HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

// ─── Config builders ──────────────────────────────────────────────────────────

/** Org hierarchy node — no knowledge entries, exists to anchor the tree. */
function nodeConfig(groupId, displayName, level, parentGroupId = null) {
  return {
    group_id: groupId,
    owner:    OWNER,
    is_hierarchy_anchor: true,
    members:  [{ name: OWNER, github_username: OWNER, role: 'principal_architect', team: 'platform' }],
    roles:    { principal_architect: { base_confidence: 0.95 } },
    hierarchy: {
      level,
      node_id:      groupId,
      display_name: displayName,
      criticality:  3,
      ...(parentGroupId ? { parent: parentGroupId } : {}),
    },
    globals:    [],
    domains:    {},
    thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
  }
}

/** Global knowledge catalog — has entries, linked to a hierarchy parent. */
function config(groupId, displayName, nodeId, parentGroupId = null) {
  return {
    group_id:     groupId,
    owner:        OWNER,
    is_global:    true,
    global_scope: 'org',
    is_public:    true,
    hierarchy: {
      level:        'service',
      node_id:      nodeId,
      display_name: displayName,
      criticality:  5,
      ...(parentGroupId ? { parent: parentGroupId } : {}),
    },
    members: [{
      name:            OWNER,
      github_username: OWNER,
      role:            'principal_architect',
      team:            'platform',
    }],
    roles: {
      principal_architect: { base_confidence: 0.95 },
      senior_engineer:     { base_confidence: 0.80 },
      engineer:            { base_confidence: 0.70 },
    },
  }
}

// ─── Org hierarchy nodes ───────────────────────────────────────────────────────
// ayan-org → group-a/b/c → div-a/b/c → dep-a/b/c → catalog services

const HIERARCHY_NODES = [
  nodeConfig('ayan-org', 'Ayan Org',     'org'),
  nodeConfig('group-a',  'Group A',      'group',      'ayan-org'),
  nodeConfig('group-b',  'Group B',      'group',      'ayan-org'),
  nodeConfig('group-c',  'Group C',      'group',      'ayan-org'),
  nodeConfig('div-a',    'Division A',   'division',   'group-a'),
  nodeConfig('div-b',    'Division B',   'division',   'group-b'),
  nodeConfig('div-c',    'Division C',   'division',   'group-c'),
  nodeConfig('dep-a',    'Department A', 'department', 'div-a'),
  nodeConfig('dep-b',    'Department B', 'department', 'div-b'),
  nodeConfig('dep-c',    'Department C', 'department', 'div-c'),
]

// ─── Catalogs ─────────────────────────────────────────────────────────────────

const CATALOGS = [

  // ── 1. Security ──────────────────────────────────────────────────────────────
  {
    config: config('security-knowledge', 'Security Standards', 'standards/security', 'dep-a'),
    entries: [
      {
        topic: 'security', key: 'sql-injection-prevention',
        entity_type: 'Constraint', confidence: 0.95,
        tags: ['security', 'database', 'constraint'],
        summary: 'All database queries must use parameterised queries or prepared statements. No string interpolation allowed in SQL. Applies to all ORMs and raw query interfaces.',
      },
      {
        topic: 'security', key: 'secrets-not-in-source',
        entity_type: 'Constraint', confidence: 0.98,
        tags: ['security', 'secrets', 'constraint'],
        summary: 'No secrets, tokens, passwords, or API keys may be committed to source code or baked into Docker images. All secrets injected at runtime via environment variables or a secret manager.',
      },
      {
        topic: 'security', key: 'input-validation-boundary',
        entity_type: 'Standard', confidence: 0.92,
        tags: ['security', 'api', 'validation'],
        summary: 'All external input must be validated and sanitised at API boundaries before processing. Use a schema validator (Zod, Joi). Never trust data from external sources without validation.',
      },
      {
        topic: 'security', key: 'dependency-vulnerability-policy',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['security', 'dependencies', 'ci'],
        summary: 'Run npm audit or equivalent before every release. Block merge on any high or critical severity vulnerability. Apply critical security patches within 24 hours of public disclosure.',
      },
      {
        topic: 'security', key: 'jwt-algorithm-policy',
        entity_type: 'Constraint', confidence: 0.93,
        tags: ['security', 'auth', 'jwt'],
        summary: 'JWTs must use asymmetric signing (ES256 minimum). HS256 is prohibited in multi-service contexts. Verify using the issuer public key. Access token expiry: 1h. Refresh: 30d.',
      },
      {
        topic: 'security', key: 'rate-limiting-public-endpoints',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['security', 'api', 'rate-limit'],
        summary: 'All public-facing API endpoints must have rate limiting. Default: 100 req/min per IP. Auth endpoints: 10 req/min. Exceeded requests return 429 with Retry-After header.',
      },
      {
        topic: 'security', key: 'cors-no-wildcard',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['security', 'api', 'cors'],
        summary: 'CORS must specify explicit allowed origins. Wildcard (*) is prohibited for any endpoint that sets or reads cookies or sends an Authorization header.',
      },
      {
        topic: 'security', key: 'error-message-sanitisation',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['security', 'api', 'errors'],
        summary: 'Internal error details (stack traces, query text, file paths) must never appear in API responses. Log internally; return a sanitised message and a correlation ID externally.',
      },
      {
        topic: 'security', key: 'tls-required',
        entity_type: 'Constraint', confidence: 0.95,
        tags: ['security', 'infra', 'tls'],
        summary: 'All service-to-service and client-to-service communication must use TLS in staging and production. Plain HTTP only permitted on the local loopback interface in development.',
      },
      {
        topic: 'security', key: 'mfa-admin-access',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['security', 'auth', 'admin'],
        summary: 'MFA is required for all admin and production system access. SSH access to production hosts requires an approved bastion host with audit logging enabled.',
      },
    ],
  },

  // ── 2. Best Practices ────────────────────────────────────────────────────────
  {
    config: config('best-practices', 'Engineering Best Practices', 'standards/practices', 'dep-a'),
    entries: [
      {
        topic: 'practices', key: 'conventional-commits',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['practices', 'git', 'convention'],
        summary: 'All commits must follow Conventional Commits spec (feat/fix/chore/docs/refactor/test). Subject: max 72 chars, imperative mood, lowercase. Breaking changes use BREAKING CHANGE footer.',
      },
      {
        topic: 'practices', key: 'pr-review-required',
        entity_type: 'Standard', confidence: 0.92,
        tags: ['practices', 'review', 'collaboration'],
        summary: 'All pull requests require at least one approval from a team member before merge. No self-approval. Branch protection with required status checks enforced at the remote.',
      },
      {
        topic: 'practices', key: 'test-coverage-minimum',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['practices', 'testing', 'quality'],
        summary: 'Unit and integration test coverage must not drop below 75% lines and branches. New code must have corresponding tests. Coverage gate enforced in CI — builds fail below threshold.',
      },
      {
        topic: 'practices', key: 'no-direct-main-push',
        entity_type: 'Constraint', confidence: 0.95,
        tags: ['practices', 'git', 'constraint'],
        summary: 'Direct pushes to main or master are prohibited. All changes must go through a pull request. Branch protection rules enforced at the remote for all production repos.',
      },
      {
        topic: 'practices', key: 'error-handling-explicit',
        entity_type: 'Guideline', confidence: 0.88,
        tags: ['practices', 'quality', 'errors'],
        summary: 'Errors must be handled explicitly. No empty or silent catch blocks. Log or rethrow; never swallow exceptions without a comment explaining the intent.',
      },
      {
        topic: 'practices', key: 'pr-size-limit',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['practices', 'review', 'quality'],
        summary: 'Pull requests should change fewer than 400 lines. Larger changes must be split into logical units. Refactoring and feature work should be in separate PRs where possible.',
      },
      {
        topic: 'practices', key: 'dependency-update-cadence',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['practices', 'dependencies', 'maintenance'],
        summary: 'Dependencies must be reviewed and updated at least quarterly. Patch updates can be batched weekly via automated PRs. Critical security patches applied within 24 hours of disclosure.',
      },
      {
        topic: 'practices', key: 'documentation-required',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['practices', 'documentation', 'quality'],
        summary: 'All public APIs and exported functions must have JSDoc or equivalent documentation. README must include setup, usage, and testing instructions before first release.',
      },
      {
        topic: 'practices', key: 'no-todo-without-issue',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['practices', 'quality', 'debt'],
        summary: 'TODO and FIXME comments must not be merged to main without a linked issue number. Format: TODO(#123): description. Unlinked TODOs are a code review blocking concern.',
      },
      {
        topic: 'practices', key: 'branch-naming-convention',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['practices', 'git', 'convention'],
        summary: 'Branches must follow: feat/slug, fix/slug, chore/slug, refactor/slug, or hotfix/slug. Slugs use hyphens, lowercase only. Generic names like dev, test, or my-branch are prohibited.',
      },
    ],
  },

  // ── 3. Frontend ──────────────────────────────────────────────────────────────
  {
    config: config('frontend-standards', 'Frontend Standards (React / Next.js)', 'standards/frontend', 'dep-b'),
    entries: [
      {
        topic: 'frontend', key: 'component-naming',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['frontend', 'react', 'convention'],
        summary: 'React components must use PascalCase naming. File names must match the component name. One component per file. Use named exports — no default exports for named components.',
      },
      {
        topic: 'frontend', key: 'server-state-tanstack-query',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['frontend', 'react', 'state', 'nextjs'],
        summary: 'Server state must be managed with TanStack Query v5+. No manual fetch-in-useEffect patterns for remote data. staleTime defaults: 30–60s. Use useQuery for reads, useMutation for writes.',
      },
      {
        topic: 'frontend', key: 'no-prop-drilling',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['frontend', 'react', 'architecture'],
        summary: 'Props must not be drilled more than two component levels. For deeper trees use React context, a state manager, or component composition. Prop drilling beyond two levels is a review concern.',
      },
      {
        topic: 'frontend', key: 'image-optimisation',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['frontend', 'nextjs', 'performance'],
        summary: 'Use Next.js Image component for all images. No raw img tags in Next.js pages. Always provide width, height, and alt props. Use priority prop for above-the-fold images.',
      },
      {
        topic: 'frontend', key: 'accessibility-aria',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['frontend', 'accessibility', 'react'],
        summary: 'All interactive elements must have accessible labels (aria-label or aria-labelledby). Run axe-core or equivalent in CI. WCAG AA compliance required for all user-facing pages.',
      },
      {
        topic: 'frontend', key: 'api-route-validation',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['frontend', 'nextjs', 'validation'],
        summary: 'All Next.js API routes and Server Actions must validate input with Zod before processing. Return 400 with structured field-level errors on validation failure. Never trust client data.',
      },
      {
        topic: 'frontend', key: 'server-component-default',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['frontend', 'nextjs', 'react', 'performance'],
        summary: "Mark components as client components only when necessary (event handlers, hooks, browser APIs). Default to server components for data-fetching and layout to reduce bundle size.",
      },
      {
        topic: 'frontend', key: 'dynamic-import-heavy-libs',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['frontend', 'nextjs', 'performance'],
        summary: 'Components importing chart libraries, rich text editors, maps, or PDF renderers must use dynamic import with ssr: false and a loading skeleton to reduce the initial bundle size.',
      },
      {
        topic: 'frontend', key: 'error-boundaries',
        entity_type: 'Guideline', confidence: 0.87,
        tags: ['frontend', 'react', 'reliability'],
        summary: 'All page-level components must be wrapped in an ErrorBoundary or Next.js error.tsx. Show a user-friendly fallback UI. Never let a runtime error render a blank screen.',
      },
      {
        topic: 'frontend', key: 'no-inline-styles',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['frontend', 'react', 'styling'],
        summary: 'Use Tailwind utility classes or CSS modules for all styling. No inline style attributes except for dynamic values (e.g. widths derived from data). Inline styles defeat purging and theming.',
      },
    ],
  },

  // ── 4. Backend ───────────────────────────────────────────────────────────────
  {
    config: config('backend-standards', 'Backend Standards (Node.js)', 'standards/backend', 'dep-b'),
    entries: [
      {
        topic: 'backend', key: 'async-error-handling',
        entity_type: 'Standard', confidence: 0.92,
        tags: ['backend', 'nodejs', 'errors'],
        summary: 'All async functions must handle errors explicitly with try/catch or .catch(). Never allow unhandled promise rejections. Register process.on unhandledRejection to log and exit safely.',
      },
      {
        topic: 'backend', key: 'database-transactions',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['backend', 'database', 'reliability'],
        summary: 'Multi-step database operations that must be atomic must use a transaction with ROLLBACK on error. Never rely on application-level rollback or compensating writes for atomicity.',
      },
      {
        topic: 'backend', key: 'structured-logging',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['backend', 'nodejs', 'observability'],
        summary: 'Use structured JSON logging (pino or equivalent). No console.log in production. Log level via LOG_LEVEL env var. All log entries must include: service, request_id, and level.',
      },
      {
        topic: 'backend', key: 'request-validation',
        entity_type: 'Standard', confidence: 0.92,
        tags: ['backend', 'api', 'validation'],
        summary: 'All API request bodies, query params, and path params must be validated with Zod or equivalent before processing. Return 400 with field-level error details on validation failure.',
      },
      {
        topic: 'backend', key: 'connection-pool-management',
        entity_type: 'Constraint', confidence: 0.88,
        tags: ['backend', 'database', 'performance'],
        summary: 'Database connections must be managed via a connection pool. Never open or close connections per request. Default pool: 10 min, 20 max. Pool size configurable via environment variables.',
      },
      {
        topic: 'backend', key: 'idempotent-mutations',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['backend', 'api', 'reliability'],
        summary: 'Creation and mutation endpoints must be idempotent where possible. Support Idempotency-Key header for payment and order endpoints. Return identical responses for duplicate requests.',
      },
      {
        topic: 'backend', key: 'pagination-required',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['backend', 'api', 'performance'],
        summary: 'All list endpoints must support pagination (limit/offset or cursor-based). Default limit: 20. Maximum limit: 100. Never return unbounded result sets. Include total count where feasible.',
      },
      {
        topic: 'backend', key: 'health-endpoint',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['backend', 'nodejs', 'infra'],
        summary: 'All services must expose GET /health returning { status: "healthy", components: {...} } with per-dependency checks. Used by load balancers. Response time must be under 100ms.',
      },
      {
        topic: 'backend', key: 'graceful-shutdown',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['backend', 'nodejs', 'reliability'],
        summary: 'Services must handle SIGTERM by completing in-flight requests before exiting. Stop accepting new connections immediately. Maximum shutdown timeout: 30s. Log the shutdown sequence.',
      },
      {
        topic: 'backend', key: 'environment-config',
        entity_type: 'Constraint', confidence: 0.93,
        tags: ['backend', 'nodejs', 'config'],
        summary: 'All configuration must come from environment variables. No hardcoded URLs, ports, credentials, or thresholds in source code. Config module validates required vars at startup and fails fast.',
      },
    ],
  },

  // ── 5. Infra ─────────────────────────────────────────────────────────────────
  {
    config: config('infra-standards', 'Infrastructure Standards (CI/CD)', 'standards/infra', 'dep-c'),
    entries: [
      {
        topic: 'infra', key: 'secrets-not-in-images',
        entity_type: 'Constraint', confidence: 0.98,
        tags: ['infra', 'security', 'docker'],
        summary: 'Secrets must never be baked into Docker images or IaC repositories. Inject at runtime via environment variables or a secret manager (AWS SSM, Vault). Scan images for secrets in CI.',
      },
      {
        topic: 'infra', key: 'environment-parity',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['infra', 'docker', 'reliability'],
        summary: 'Dev, staging, and production must use the same Docker image built from the same Dockerfile. No environment-specific builds. All differences expressed via environment variables only.',
      },
      {
        topic: 'infra', key: 'infrastructure-as-code',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['infra', 'iac', 'terraform'],
        summary: 'All infrastructure must be defined as code (Terraform, CDK, or Helm). No manual console changes in staging or production. Manual changes must be codified within 24 hours.',
      },
      {
        topic: 'infra', key: 'ci-pipeline-required',
        entity_type: 'Constraint', confidence: 0.95,
        tags: ['infra', 'ci', 'quality'],
        summary: 'All repos must have a CI pipeline running lint, type-check, tests, and security scan on every PR. PRs cannot merge if CI fails. Pipeline config must be committed in the repo.',
      },
      {
        topic: 'infra', key: 'rollback-capability',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['infra', 'deployment', 'reliability'],
        summary: 'All production deployments must support one-command rollback to the previous version. Rollback procedure documented in the service runbook. Target recovery time: under 5 minutes.',
      },
      {
        topic: 'infra', key: 'dependency-pinning',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['infra', 'dependencies', 'reproducibility'],
        summary: 'All dependencies must be pinned to exact versions in lock files (package-lock.json, poetry.lock, go.sum). Lock files must be committed. Floating version ranges prohibited in production.',
      },
      {
        topic: 'infra', key: 'image-immutable-tags',
        entity_type: 'Constraint', confidence: 0.93,
        tags: ['infra', 'docker', 'deployment'],
        summary: 'Container images must never use the :latest tag in staging or production. Use immutable tags: commit SHA or semver. The :latest tag is only acceptable in local development.',
      },
      {
        topic: 'infra', key: 'resource-limits-kubernetes',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['infra', 'kubernetes', 'reliability'],
        summary: 'All Kubernetes pods must declare CPU and memory requests and limits. No unbounded resource consumption. Requests set to p50 observed usage; limits set to 2x requests. Review quarterly.',
      },
      {
        topic: 'infra', key: 'monitoring-and-alerting',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['infra', 'observability', 'slo'],
        summary: 'All production services must have health monitoring and alerting for error rate, p99 latency, and availability. SLO: 99.9% uptime. Alert within 5 minutes of any SLO breach.',
      },
      {
        topic: 'infra', key: 'backup-restore-tested',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['infra', 'database', 'reliability'],
        summary: 'All stateful services must have automated daily backups with tested restore procedures. Restore drill required quarterly. RTO: 4 hours. RPO: 24 hours.',
      },
    ],
  },

  // ── 6. Architecture Principles ───────────────────────────────────────────────
  {
    config: config('architecture-principles', 'Architecture & Design Principles', 'standards/architecture', 'dep-a'),
    entries: [
      {
        topic: 'architecture', key: 'soa-service-boundaries',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['architecture', 'soa', 'boundaries'],
        summary: 'Services own their data exclusively — no other service may read or write another service\'s database directly. Cross-service communication happens only through a versioned API contract (REST, gRPC, or event) or a published schema.',
      },
      {
        topic: 'architecture', key: 'kiss-simplicity-over-cleverness',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['architecture', 'kiss', 'maintainability'],
        summary: 'Choose the simplest design that satisfies the current requirement. Cleverness, premature abstraction, and speculative flexibility are review concerns unless a concrete, cited need justifies the added complexity.',
      },
      {
        topic: 'architecture', key: 'dry-rule-of-three',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['architecture', 'dry', 'duplication'],
        summary: 'Duplicate logic is tolerated twice; extract a shared abstraction on the third occurrence (rule of three). Do not extract on the first duplication — premature abstraction is a worse failure mode than temporary duplication.',
      },
      {
        topic: 'architecture', key: 'slap-single-level-of-abstraction',
        entity_type: 'Guideline', confidence: 0.83,
        tags: ['architecture', 'slap', 'readability'],
        summary: 'Each function body must operate at one level of abstraction. A function that mixes high-level orchestration (e.g. "process order") with low-level detail (e.g. string parsing) must extract the low-level steps into named helpers.',
      },
      {
        topic: 'architecture', key: 'srp-single-responsibility',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['architecture', 'srp', 'maintainability'],
        summary: 'A module, class, or function must have exactly one reason to change. If a code review requires "and" to describe what a unit does, it is a candidate for splitting.',
      },
      {
        topic: 'architecture', key: 'yagni-no-speculative-generality',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['architecture', 'yagni', 'simplicity'],
        summary: 'Do not build configuration options, extension points, or abstraction layers for requirements that do not yet exist. Generalise only after a second concrete use case appears.',
      },
      {
        topic: 'architecture', key: 'law-of-demeter',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['architecture', 'coupling', 'encapsulation'],
        summary: 'A method should only call methods on itself, its parameters, objects it creates, or its direct fields — not on objects returned by those calls. Chains like a.getB().getC().doThing() indicate a boundary violation.',
      },
      {
        topic: 'architecture', key: 'composition-over-inheritance',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['architecture', 'composition', 'oop'],
        summary: 'Prefer composing small, single-purpose objects over deep inheritance hierarchies. Inheritance is reserved for genuine is-a relationships with stable, shared behaviour — not for code reuse alone.',
      },
      {
        topic: 'architecture', key: 'dependency-inversion',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['architecture', 'dip', 'testability'],
        summary: 'High-level modules must depend on abstractions (interfaces, injected clients), not on concrete low-level implementations. This is required wherever a module talks to a database, external API, or filesystem, to keep it unit-testable.',
      },
      {
        topic: 'architecture', key: 'fail-fast-explicit-contracts',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['architecture', 'reliability', 'contracts'],
        summary: 'Validate preconditions at the start of a function and throw immediately on violation. Do not let invalid state silently propagate deeper into the call stack where the failure becomes harder to attribute.',
      },
    ],
  },

  // ── 7. OWASP Top 10 (2021) ───────────────────────────────────────────────────
  {
    config: config('owasp-standards', 'OWASP Top 10 (2021) Compliance', 'standards/owasp', 'dep-a'),
    entries: [
      {
        topic: 'owasp', key: 'a01-broken-access-control',
        entity_type: 'Constraint', confidence: 0.93,
        tags: ['owasp', 'a01', 'access-control'],
        summary: 'OWASP A01:2021. Enforce access control server-side on every request — never trust a client-supplied role or ID. Deny by default; require explicit authorization checks for object-level access (IDOR prevention) on every resource fetch.',
      },
      {
        topic: 'owasp', key: 'a02-cryptographic-failures',
        entity_type: 'Constraint', confidence: 0.93,
        tags: ['owasp', 'a02', 'cryptography'],
        summary: 'OWASP A02:2021. Encrypt sensitive data at rest (AES-256) and in transit (TLS 1.2+). Never use deprecated algorithms (MD5, SHA1, DES). Passwords must be hashed with bcrypt/argon2 — never encrypted or stored in plaintext.',
      },
      {
        topic: 'owasp', key: 'a03-injection',
        entity_type: 'Constraint', confidence: 0.95,
        tags: ['owasp', 'a03', 'injection'],
        summary: 'OWASP A03:2021. All queries (SQL, NoSQL, LDAP, OS command) must use parameterised interfaces or an ORM — never string concatenation with user input. Applies equally to template engines and shell command construction.',
      },
      {
        topic: 'owasp', key: 'a04-insecure-design',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['owasp', 'a04', 'threat-modeling'],
        summary: 'OWASP A04:2021. New features touching auth, payments, or PII require a lightweight threat model (abuse cases + mitigations) before implementation begins, not retrofitted after a security review finds gaps.',
      },
      {
        topic: 'owasp', key: 'a05-security-misconfiguration',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['owasp', 'a05', 'configuration'],
        summary: 'OWASP A05:2021. Disable directory listing, verbose error pages, and default credentials in every environment. Security headers (CSP, X-Content-Type-Options, X-Frame-Options) required on all HTTP responses.',
      },
      {
        topic: 'owasp', key: 'a06-vulnerable-outdated-components',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['owasp', 'a06', 'dependencies'],
        summary: 'OWASP A06:2021. Maintain an inventory of dependencies and their versions (SBOM). Remove unused dependencies. No component past end-of-life may run in production; patch known-CVE components within the severity-based SLA.',
      },
      {
        topic: 'owasp', key: 'a07-identification-authentication-failures',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['owasp', 'a07', 'authentication'],
        summary: 'OWASP A07:2021. Enforce credential strength, lock out after repeated failed attempts (progressive backoff), and invalidate session tokens on logout and password change. No credential stuffing protection means no production launch.',
      },
      {
        topic: 'owasp', key: 'a08-software-data-integrity-failures',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['owasp', 'a08', 'integrity'],
        summary: 'OWASP A08:2021. CI/CD pipelines and auto-update mechanisms must verify signatures or checksums before applying code or dependencies. Never deserialize untrusted data without a strict, allow-listed schema.',
      },
      {
        topic: 'owasp', key: 'a09-logging-monitoring-failures',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['owasp', 'a09', 'logging'],
        summary: 'OWASP A09:2021. Log authentication, access-control, and input-validation failures with enough context to investigate (actor, timestamp, source IP) — but never log credentials or full tokens. Alert on repeated failures.',
      },
      {
        topic: 'owasp', key: 'a10-server-side-request-forgery',
        entity_type: 'Constraint', confidence: 0.87,
        tags: ['owasp', 'a10', 'ssrf'],
        summary: 'OWASP A10:2021. Any server-side feature that fetches a URL supplied by a user (webhooks, image proxies, link previews) must validate against an allow-list and block requests to internal/private IP ranges and cloud metadata endpoints.',
      },
    ],
  },

  // ── 8. Performance ────────────────────────────────────────────────────────────
  {
    config: config('performance-standards', 'Performance Standards', 'standards/performance', 'dep-b'),
    entries: [
      {
        topic: 'performance', key: 'n-plus-one-query-prevention',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['performance', 'database', 'orm'],
        summary: 'List endpoints and ORM relations must use eager loading, joins, or batched dataloaders. A query issued once per row in a loop (N+1) is a merge-blocking review finding, not a later optimisation.',
      },
      {
        topic: 'performance', key: 'caching-strategy-required',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['performance', 'caching'],
        summary: 'Expensive or frequently-read computations must define an explicit caching layer (in-memory, Redis, or CDN) with a stated TTL and invalidation trigger. Caches without an invalidation strategy are not approved.',
      },
      {
        topic: 'performance', key: 'database-indexing-required',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['performance', 'database', 'indexing'],
        summary: 'Any column used in a WHERE, JOIN, or ORDER BY on a table expected to exceed 10k rows must be indexed. New query patterns require an EXPLAIN plan review before merge.',
      },
      {
        topic: 'performance', key: 'algorithmic-complexity-review',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['performance', 'algorithms'],
        summary: 'Code on a hot path (request handlers, per-item loop bodies) exceeding O(n log n) requires an explicit justification comment. Nested loops over unbounded collections are a review-blocking concern.',
      },
      {
        topic: 'performance', key: 'async-non-blocking-io',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['performance', 'nodejs', 'io'],
        summary: 'All I/O (network, disk, database) must be non-blocking. Synchronous filesystem calls (readFileSync, etc.) are prohibited on any request-handling path in production code.',
      },
      {
        topic: 'performance', key: 'load-testing-before-launch',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['performance', 'testing', 'capacity'],
        summary: 'New public-facing endpoints must be load tested to at least 2x projected peak traffic before launch. Capture p50/p95/p99 latency and error rate at target load; document the result in the launch checklist.',
      },
      {
        topic: 'performance', key: 'bundle-size-budget',
        entity_type: 'Constraint', confidence: 0.85,
        tags: ['performance', 'frontend', 'bundle'],
        summary: 'Initial JS bundle for any client-rendered route must not exceed 250KB gzipped. CI fails the build on regression past budget; new heavy dependencies require dynamic import or an explicit budget exception.',
      },
      {
        topic: 'performance', key: 'cdn-static-assets',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['performance', 'cdn', 'assets'],
        summary: 'Static assets (images, fonts, compiled JS/CSS) must be served through a CDN with long-lived cache headers and content-hashed filenames for safe cache-busting on deploy.',
      },
      {
        topic: 'performance', key: 'lazy-loading-non-critical-assets',
        entity_type: 'Guideline', confidence: 0.83,
        tags: ['performance', 'frontend', 'loading'],
        summary: 'Below-the-fold images, non-critical scripts, and rarely-visited route chunks must be lazy-loaded. Only content required for first paint should block the initial render.',
      },
      {
        topic: 'performance', key: 'memory-leak-prevention',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['performance', 'reliability', 'memory'],
        summary: 'Event listeners, timers, and subscriptions must be explicitly removed on component unmount or connection close. Long-running processes must be profiled for memory growth before being marked production-ready.',
      },
    ],
  },

  // ── 9. Testing ────────────────────────────────────────────────────────────────
  {
    config: config('testing-standards', 'Testing & Quality Standards', 'standards/testing', 'dep-b'),
    entries: [
      {
        topic: 'testing', key: 'test-pyramid-shape',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['testing', 'strategy'],
        summary: 'Maintain a test pyramid: the majority of tests are fast unit tests, a smaller layer is integration tests against real dependencies, and the fewest are end-to-end browser tests. Inverting this shape is a quality risk.',
      },
      {
        topic: 'testing', key: 'no-live-network-in-unit-tests',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['testing', 'unit', 'isolation'],
        summary: 'Unit tests must not make real network calls or hit a live database. External dependencies are mocked or faked at the boundary. Tests requiring real infrastructure belong in the integration or E2E layer.',
      },
      {
        topic: 'testing', key: 'flaky-test-quarantine-policy',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['testing', 'ci', 'reliability'],
        summary: 'A test that fails intermittently without a code change is quarantined (skip + linked issue) within one CI run of being identified as flaky — it is never left failing silently or ignored via blind retries.',
      },
      {
        topic: 'testing', key: 'contract-testing-cross-service',
        entity_type: 'Standard', confidence: 0.83,
        tags: ['testing', 'contracts', 'integration'],
        summary: 'Services that consume another team\'s API must maintain a contract test (e.g. Pact, or a shared schema fixture) that fails when the provider changes its response shape in a breaking way.',
      },
      {
        topic: 'testing', key: 'regression-test-on-bugfix',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['testing', 'bugfix', 'quality'],
        summary: 'Every bug fix must include a test that fails before the fix and passes after. A fix without a reproducing test is not mergeable, since it gives no protection against the same defect returning.',
      },
      {
        topic: 'testing', key: 'test-data-isolation',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['testing', 'fixtures', 'e2e'],
        summary: 'Test fixtures must be uniquely keyed per run (e.g. a uid() prefix) rather than relying on shared, hand-seeded records. Tests must never depend on execution order or leftover state from a prior run.',
      },
      {
        topic: 'testing', key: 'ci-test-parallelization',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['testing', 'ci', 'performance'],
        summary: 'Test suites exceeding 5 minutes sequential runtime must be split across parallel CI workers or sharded by file. Test isolation (no shared mutable state) is a prerequisite for safe parallelization.',
      },
      {
        topic: 'testing', key: 'mocking-boundary-external-only',
        entity_type: 'Guideline', confidence: 0.85,
        tags: ['testing', 'mocking', 'design'],
        summary: 'Mock only true external boundaries (network, filesystem, clock, third-party SDKs). Mocking internal collaborators within the same module under test is a sign the test is coupled to implementation, not behaviour.',
      },
      {
        topic: 'testing', key: 'mutation-testing-critical-paths',
        entity_type: 'Guideline', confidence: 0.75,
        tags: ['testing', 'quality', 'coverage'],
        summary: 'Core business-logic modules (billing, auth, governance rules) should be periodically checked with mutation testing to confirm coverage percentage reflects real assertion strength, not just line execution.',
      },
      {
        topic: 'testing', key: 'test-naming-behavior-driven',
        entity_type: 'Guideline', confidence: 0.82,
        tags: ['testing', 'readability', 'naming'],
        summary: 'Test names describe observable behaviour and the scenario under test (e.g. "rejects login after 5 failed attempts"), not implementation details (e.g. "calls checkAttempts"). A failing test name should explain the break without opening the file.',
      },
    ],
  },

  // ── 10. Observability ─────────────────────────────────────────────────────────
  {
    config: config('observability-standards', 'Observability Standards', 'standards/observability', 'dep-c'),
    entries: [
      {
        topic: 'observability', key: 'correlation-id-propagation',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['observability', 'tracing', 'logging'],
        summary: 'Every inbound request is assigned a correlation/request ID at the edge and propagated through every downstream service call and log line. Without it, a single user-facing error cannot be traced across services.',
      },
      {
        topic: 'observability', key: 'distributed-tracing-required',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['observability', 'tracing', 'opentelemetry'],
        summary: 'Services making calls to other services or external APIs must be instrumented with OpenTelemetry (or equivalent) so a single request can be traced end-to-end across service boundaries with span-level timing.',
      },
      {
        topic: 'observability', key: 'red-use-metrics',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['observability', 'metrics'],
        summary: 'Services expose RED metrics (Rate, Errors, Duration) per endpoint; infrastructure resources expose USE metrics (Utilization, Saturation, Errors). Dashboards without these baseline metrics are considered incomplete.',
      },
      {
        topic: 'observability', key: 'slo-error-budget-defined',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['observability', 'slo', 'reliability'],
        summary: 'Every production service defines an explicit SLO (e.g. 99.9% availability, p99 latency under 500ms) and tracks an error budget. Budget exhaustion triggers a review before further feature releases to that service.',
      },
      {
        topic: 'observability', key: 'alert-on-symptoms-not-causes',
        entity_type: 'Guideline', confidence: 0.83,
        tags: ['observability', 'alerting'],
        summary: 'Page on user-facing symptoms (elevated error rate, latency breach, availability drop), not on every internal cause (a single pod restart, a transient retry). Cause-level signals belong in dashboards, not pages.',
      },
      {
        topic: 'observability', key: 'dashboards-per-service',
        entity_type: 'Standard', confidence: 0.83,
        tags: ['observability', 'dashboards'],
        summary: 'Each production service has one canonical dashboard covering RED metrics, dependency health, and recent deploys. On-call must be able to assess service health from this single view without querying raw logs first.',
      },
      {
        topic: 'observability', key: 'log-retention-policy',
        entity_type: 'Constraint', confidence: 0.85,
        tags: ['observability', 'logging', 'compliance'],
        summary: 'Application logs are retained 30 days in hot storage and 1 year in cold/archive storage for compliance-relevant services. Retention periods must be documented per service and enforced by the logging pipeline, not manual cleanup.',
      },
      {
        topic: 'observability', key: 'runbook-per-alert',
        entity_type: 'Constraint', confidence: 0.87,
        tags: ['observability', 'alerting', 'runbook'],
        summary: 'Every paging alert links to a runbook describing likely causes, first diagnostic steps, and escalation path. An alert with no runbook is not approved for production paging.',
      },
      {
        topic: 'observability', key: 'blameless-postmortem-required',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['observability', 'incident', 'postmortem'],
        summary: 'Every Sev1/Sev2 incident gets a blameless postmortem within 5 business days: timeline, root cause, contributing factors, and follow-up actions with owners. The focus is systemic gaps, not individual blame.',
      },
      {
        topic: 'observability', key: 'synthetic-monitoring-critical-paths',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['observability', 'monitoring', 'availability'],
        summary: 'Critical user journeys (login, checkout, core write path) are covered by synthetic monitoring that runs continuously from outside the infrastructure, so an outage is detected before a user reports it.',
      },
    ],
  },

  // ── 11. Documentation ─────────────────────────────────────────────────────────
  {
    config: config('documentation-standards', 'Documentation Standards', 'standards/documentation', 'dep-c'),
    entries: [
      {
        topic: 'documentation', key: 'adr-for-significant-decisions',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['documentation', 'adr', 'architecture'],
        summary: 'Decisions that are expensive to reverse (data model, cross-service contracts, major dependency choices) are recorded as an Architecture Decision Record: context, decision, alternatives considered, and consequences.',
      },
      {
        topic: 'documentation', key: 'readme-minimum-sections',
        entity_type: 'Constraint', confidence: 0.85,
        tags: ['documentation', 'readme'],
        summary: 'Every repository README must include: purpose/overview, setup instructions, how to run tests, and how to run the project locally. A repo without these four sections is considered undocumented, not partially documented.',
      },
      {
        topic: 'documentation', key: 'api-docs-openapi-required',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['documentation', 'api', 'openapi'],
        summary: 'All HTTP APIs are documented with an OpenAPI 3.1 spec kept in the same repo as the code and updated in the same PR that changes a route. A route not reflected in the spec is treated as undocumented.',
      },
      {
        topic: 'documentation', key: 'comments-explain-why-not-what',
        entity_type: 'Guideline', confidence: 0.83,
        tags: ['documentation', 'comments', 'readability'],
        summary: 'Code comments explain non-obvious rationale — a hidden constraint, a workaround for a specific bug, a subtle invariant — not what well-named code already shows. A comment restating the next line is noise, not documentation.',
      },
      {
        topic: 'documentation', key: 'changelog-per-release',
        entity_type: 'Standard', confidence: 0.83,
        tags: ['documentation', 'changelog', 'release'],
        summary: 'Every versioned release updates a CHANGELOG following Keep a Changelog conventions (Added/Changed/Fixed/Removed), so consumers can assess impact without reading commit history.',
      },
      {
        topic: 'documentation', key: 'diagrams-as-code',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['documentation', 'diagrams'],
        summary: 'Architecture and flow diagrams are authored as code (Mermaid, PlantUML) and committed alongside the docs they support, so they can be diffed and kept current in the same PR as the change they describe.',
      },
      {
        topic: 'documentation', key: 'doc-freshness-review',
        entity_type: 'Guideline', confidence: 0.78,
        tags: ['documentation', 'maintenance'],
        summary: 'Key reference documents (architecture overview, onboarding guide, runbooks) are reviewed for accuracy at least quarterly. A doc found to describe removed or renamed functionality is corrected or deleted, not left stale.',
      },
      {
        topic: 'documentation', key: 'deprecation-notice-required',
        entity_type: 'Constraint', confidence: 0.85,
        tags: ['documentation', 'deprecation', 'api'],
        summary: 'A deprecated API, config field, or feature must be documented with the deprecation date, the replacement, and a sunset date before removal. Silent removal without a documented notice period is prohibited.',
      },
      {
        topic: 'documentation', key: 'onboarding-doc-required',
        entity_type: 'Standard', confidence: 0.82,
        tags: ['documentation', 'onboarding'],
        summary: 'Each package/service maintains an onboarding doc sufficient for a new engineer to get a local environment running and make a first small change without needing to ask a teammate for undocumented setup steps.',
      },
      {
        topic: 'documentation', key: 'runbook-required-for-oncall',
        entity_type: 'Constraint', confidence: 0.85,
        tags: ['documentation', 'runbook', 'oncall'],
        summary: 'Every production service has an on-call runbook covering common failure modes, escalation contacts, and rollback steps. A service without a runbook is not eligible to be added to the paging rotation.',
      },
    ],
  },

  // ── 12. AI Systems — Agents, MCPs, Skills ────────────────────────────────────
  {
    config: config('ai-systems-standards', 'AI Systems & Agent Standards', 'standards/ai-systems', 'dep-c'),
    entries: [
      {
        topic: 'ai-systems', key: 'mcp-server-least-privilege',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['ai-systems', 'mcp', 'security'],
        summary: 'An MCP server exposes only the tools a client genuinely needs — no destructive or admin-scoped tool without an explicit, narrow permission grant. Broad "do anything" tools are a review-blocking design smell, not a convenience.',
      },
      {
        topic: 'ai-systems', key: 'agent-destructive-action-confirmation',
        entity_type: 'Constraint', confidence: 0.92,
        tags: ['ai-systems', 'agents', 'safety'],
        summary: 'An autonomous agent must not perform hard-to-reverse or high-blast-radius actions (force-push, delete, prod deploy, mass external communication) without an explicit human confirmation step for that specific action.',
      },
      {
        topic: 'ai-systems', key: 'prompt-injection-defense',
        entity_type: 'Standard', confidence: 0.90,
        tags: ['ai-systems', 'security', 'prompt-injection'],
        summary: 'Content fetched from external, untrusted sources (web pages, tool results, user uploads) is treated as data, never as instructions. Agents must not silently follow directives embedded in retrieved content — flag suspicious embedded instructions instead.',
      },
      {
        topic: 'ai-systems', key: 'rag-grounding-and-citation',
        entity_type: 'Standard', confidence: 0.85,
        tags: ['ai-systems', 'rag', 'hallucination'],
        summary: 'RAG-based answers must be grounded in retrieved context and cite the specific source used. An answer with no supporting retrieved passage is either flagged as unsupported or withheld, not presented with the same confidence as a grounded one.',
      },
      {
        topic: 'ai-systems', key: 'llm-output-schema-validation',
        entity_type: 'Standard', confidence: 0.88,
        tags: ['ai-systems', 'llm', 'validation'],
        summary: 'Structured output from an LLM (JSON, function-call arguments) must be validated against a strict schema before being used downstream. Malformed or schema-violating output is rejected and retried, never coerced or passed through silently.',
      },
      {
        topic: 'ai-systems', key: 'agent-human-in-the-loop-for-ambiguity',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['ai-systems', 'agents', 'governance'],
        summary: 'When an agent encounters genuine ambiguity — a decision only a human stakeholder can make, or conflicting instructions — it pauses and asks, rather than guessing and proceeding. Silent, confident guessing on ambiguous intent is a design defect.',
      },
      {
        topic: 'ai-systems', key: 'skill-single-purpose-scoping',
        entity_type: 'Guideline', confidence: 0.83,
        tags: ['ai-systems', 'skills', 'agents', 'design'],
        summary: 'A skill or subagent should have one clear responsibility and the minimal tool surface required for it. A skill that tries to handle several unrelated workflows should be split, mirroring single-responsibility for conventional modules.',
      },
      {
        topic: 'ai-systems', key: 'model-selection-cost-latency-fit',
        entity_type: 'Guideline', confidence: 0.80,
        tags: ['ai-systems', 'llm', 'cost'],
        summary: 'Select the smallest model capable of a task rather than defaulting to the largest available. Benchmark accuracy versus cost and latency for the specific task before committing to a model choice, and revisit the choice as new models ship.',
      },
      {
        topic: 'ai-systems', key: 'eval-suite-before-prompt-change',
        entity_type: 'Standard', confidence: 0.87,
        tags: ['ai-systems', 'testing', 'prompts'],
        summary: 'Changes to a production prompt, system instruction, or agent behavior must run against a regression eval suite (representative inputs + expected properties) before merge. A prompt change without an eval run is treated the same as an untested code change.',
      },
      {
        topic: 'ai-systems', key: 'ai-action-audit-logging',
        entity_type: 'Constraint', confidence: 0.90,
        tags: ['ai-systems', 'agents', 'audit'],
        summary: 'Every AI-initiated write, delete, or external call is logged with the triggering agent/session identity and a reference to the prompt or context that caused it. This is required before an agent is granted any write capability, not added retroactively after an incident.',
      },
    ],
  },
]

// ─── Upload + seed ────────────────────────────────────────────────────────────

async function uploadConfig(catalog) {
  const { group_id } = catalog.config
  process.stdout.write(`[${group_id}] uploading config... `)
  try {
    const res = await post('/config/upload', group_id, catalog.config)
    console.log(`created (q_project_id=${res.q_project_id ?? 'unknown'})`)
    return res.q_project_id
  } catch (err) {
    if (!/HTTP 409/.test(err.message)) throw err
    // Already onboarded — bootstrap POST is create-only, existing projects update via PUT.
    process.stdout.write('already onboarded, updating via PUT... ')
    const res = await put(`/config/${group_id}`, group_id, catalog.config)
    console.log(`updated (q_project_id=${res.q_project_id ?? 'unknown'})`)
    return res.q_project_id
  }
}

async function seedEntries(catalog) {
  const { group_id } = catalog.config
  let ok = 0, fail = 0
  for (const entry of catalog.entries) {
    try {
      await post('/pg/versions', group_id, {
        ...entry,
        author:      OWNER,
        author_role: 'principal_architect',
        agent_id:    'seed-global-catalogs',
        triggered_by: 'seed',
      })
      console.log(`  [${group_id}] ✓ ${entry.topic}:${entry.key}`)
      ok++
    } catch (err) {
      console.error(`  [${group_id}] ✗ ${entry.topic}:${entry.key} — ${err.message}`)
      fail++
    }
  }
  return { ok, fail }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Gateway: ${GATEWAY}`)
  console.log(`Owner:   ${OWNER}`)

  if (DRY_RUN) {
    console.log('\n[dry-run] Hierarchy nodes:')
    for (const n of HIERARCHY_NODES)
      console.log(`  ${n.hierarchy.level.padEnd(10)} ${n.group_id}${n.hierarchy.parent ? ` → ${n.hierarchy.parent}` : ''}`)
    console.log('\n[dry-run] Catalogs:')
    for (const cat of CATALOGS) {
      console.log(`\n  ${cat.config.group_id} (${cat.entries.length} entries, parent: ${cat.config.hierarchy.parent ?? 'none'})`)
      for (const e of cat.entries) console.log(`    • ${e.topic}:${e.key}`)
    }
    return
  }

  // Step 1 — upload hierarchy nodes (org → group → division → department)
  console.log('\n── Hierarchy nodes ────────────────────────────────────')
  for (const node of HIERARCHY_NODES) {
    process.stdout.write(`[${node.group_id}] uploading... `)
    try {
      const res = await post('/config/upload', node.group_id, node)
      console.log(`${res.status ?? 'ok'} (${node.hierarchy.level})`)
    } catch (err) {
      console.error(`FAILED — ${err.message}`)
    }
  }

  // Step 2 — upload catalog configs + seed entries
  console.log('\n── Catalogs ───────────────────────────────────────────')
  let totalOk = 0, totalFail = 0
  for (const catalog of CATALOGS) {
    try {
      console.log('')
      await uploadConfig(catalog)
      if (CONFIG_ONLY) continue
      const { ok, fail } = await seedEntries(catalog)
      totalOk   += ok
      totalFail += fail
    } catch (err) {
      console.error(`[${catalog.config.group_id}] FAILED: ${err.message}`)
      totalFail += catalog.entries.length
    }
  }

  console.log('\n─── Summary ──────────────────────────────────────')
  console.log(`Seeded:  ${totalOk} entries`)
  console.log(`Failed:  ${totalFail} entries`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Link a project: add the catalog group_ids to its globals[] in the config')
  console.log('  2. Upload the updated config: config_upload({ config_path: "<project>.quorum.json" })')
  console.log('  3. Record a scan: POST /pg/scans with your q_project_id')
  console.log('  4. Check conformance: conformance() or GET /api/conformance')
  console.log('  5. View portfolio: http://localhost:3002/portfolio')

  if (totalFail > 0) process.exit(1)
}

main().catch(err => { console.error(err.message); process.exit(1) })
