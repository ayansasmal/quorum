#!/usr/bin/env node
/**
 * Seeds five global catalog projects with standard knowledge entries:
 *   security-knowledge   — security constraints and baseline controls
 *   best-practices       — cross-team engineering standards
 *   frontend-standards   — React / Next.js standards
 *   backend-standards    — Node.js API and service standards
 *   infra-standards      — CI/CD, deployment, and operations standards
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
 */

const GATEWAY = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
const JWT     = process.env.QUORUM_JWT
const OWNER   = process.env.QUORUM_OWNER ?? 'ayansasmal'
const DRY_RUN = process.env.QUORUM_DRY_RUN === '1'

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
]

// ─── Upload + seed ────────────────────────────────────────────────────────────

async function uploadConfig(catalog) {
  const { group_id } = catalog.config
  process.stdout.write(`[${group_id}] uploading config... `)
  const res = await post('/config/upload', group_id, catalog.config)
  console.log(`${res.status ?? 'ok'} (q_project_id=${res.q_project_id ?? 'unknown'})`)
  return res.q_project_id
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
