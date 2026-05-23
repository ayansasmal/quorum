/**
 * Canonical topic domains per scenario.
 *
 * Each scenario owns a semantically distinct domain so FalkorDB similarity search
 * never surfaces one scenario's entries as conflicts for another's.
 *
 * Import and use uid() from seed.js for unique keys within a domain:
 *   import { uid } from './seed.js'
 *   import { DOMAINS } from './data.js'
 *   const key = uid(DOMAINS['S-01'])   // e.g. 'global-catalog-bootstrap-1716400000000'
 */

/** @type {Record<string, string>} */
export const DOMAINS = {
  'S-01':   'global-catalog-bootstrap',
  'S-02-1': 'circuit-breaker-payments',
  'S-02-2': 'retry-policy-downstream',
  'S-02-3': 'cache-invalidation-strategy',
  'S-02-4': 'connection-pool-sizing',
  'S-02-5': 'feature-flag-rollout',
  'S-02-6': 'event-sourcing-pattern',
  'S-02-7': 'saga-orchestration',
  'S-02-8': 'bulkhead-isolation',
  'S-03':   'deprecation-legacy-api',
  'S-04':   'db-migration-batch-jobs',
  'S-05':   'rbac-test-boundary',
  'S-06':   'concurrent-write-conflict',
  'S-07':   'rate-limiting-public-api',
  'S-08':   'confidence-bump-test',
  'S-09':   'admin-ops-test',
  'S-10':   'audit-chain-test',
  'S-11':   'self-approval-test',
  'S-12':   'state-machine-test',
  'S-13':   'config-governance-test',
  'S-14':   'dashboard-visual-test',
  'S-15':   'reason-placeholder-test',
  'S-16':   'knowledge-history-test',
  'S-17':   'conflict-edge-cases-test',
  'S-18':   'governance-route-test',
  'S-19':   'auth-lifecycle-test',
}
