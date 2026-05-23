/**
 * graph-reporter.js — Playwright custom reporter for the Quorum E2E suite.
 *
 * Outputs test-results/suite-graph.json after every run. The JSON encodes
 * the full 31-node DAG with live pass/fail/skip status overlaid on the
 * static OwnScore + FailureCost values from graph-schema.js.
 *
 * Registration in playwright.config.js:
 *   reporter: [['./tests/e2e/reporter/graph-reporter.js']]
 *
 * Scenario ID convention:
 *   Spec files must use a describe block whose title starts with the scenario
 *   ID — e.g. describe('S-05.1 — RBAC Knowledge Create', () => { ... }).
 *   The reporter extracts the ID via /^S-\d+(?:\.\d+)?/ from the titlePath.
 *
 * Node status values:
 *   passed    — all tests in this scenario passed (first attempt)
 *   flaky     — passed, but only after one or more retries
 *   failed    — at least one test failed
 *   correlated — this scenario passed/skipped, but its source node failed;
 *                results are unreliable due to shared code-path failure
 *   skipped   — scenario not executed (T0 failure or explicit skip)
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { NODES, EDGES, PILLARS, SUITE } from './graph-schema.js'

/** Regex to extract S-XX or S-XX.Y from a describe/test title. */
const SCENARIO_ID_RE = /^(S-\d+(?:\.\d+)?)/

/** @param {string[]} titlePath - array of describe/test titles, outermost first */
function extractScenarioId(titlePath) {
  for (const segment of titlePath) {
    const m = segment.match(SCENARIO_ID_RE)
    if (m) return m[1]
  }
  return null
}

/**
 * Merge two status values, keeping the worse one.
 * Severity order: failed > correlated > flaky > skipped > passed
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function worstStatus(a, b) {
  const rank = { failed: 5, correlated: 4, flaky: 3, skipped: 2, passed: 1 }
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b
}

/** Translate a Playwright result.status to our node status vocabulary. */
function toNodeStatus(playwrightStatus, retryCount) {
  if (playwrightStatus === 'passed') return retryCount > 0 ? 'flaky' : 'passed'
  if (playwrightStatus === 'skipped') return 'skipped'
  return 'failed'   // 'failed' | 'timedOut' | 'interrupted'
}

/**
 * Extract error information from a test result.
 * @param {import('@playwright/test/reporter').TestResult} result
 * @returns {Array<{ message: string; location: string; screenshot?: string }>}
 */
function extractErrors(result) {
  const errors = []
  for (const error of result.errors ?? []) {
    const e = { message: error.message ?? 'Unknown error', location: '' }
    if (error.location) {
      e.location = `${error.location.file}:${error.location.line}`
    }
    errors.push(e)
  }
  // Capture screenshot attachment paths (if any)
  for (const attachment of result.attachments ?? []) {
    if (attachment.name === 'screenshot' && attachment.path) {
      const last = errors[errors.length - 1]
      if (last) last.screenshot = attachment.path
    }
  }
  return errors
}

/**
 * Walk the edge list; for every node whose status is 'failed', mark its
 * direct and transitive targets as 'correlated' — but only if the target's
 * own status is 'passed' or 'skipped'. A target that failed on its own
 * stays 'failed' (independent failure, not just correlated).
 *
 * @param {Map<string, NodeResult>} results
 */
function propagateCorrelations(results) {
  // Build adjacency list
  const adj = new Map()
  for (const edge of EDGES) {
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    adj.get(edge.source).push(edge.target)
  }

  // BFS from every failed root
  const failing = [...results.entries()]
    .filter(([, v]) => v.status === 'failed')
    .map(([id]) => id)

  const queue = [...failing]
  const visited = new Set()

  while (queue.length > 0) {
    const sourceId = queue.shift()
    if (visited.has(sourceId)) continue
    visited.add(sourceId)

    for (const targetId of (adj.get(sourceId) ?? [])) {
      const target = results.get(targetId)
      if (!target) continue

      // Mark correlated only if the target's own tests didn't fail independently
      if (target.status === 'passed' || target.status === 'skipped' || target.status === 'flaky') {
        target.status = 'correlated'
        target.correlatedFrom = sourceId
        queue.push(targetId)  // propagate transitively
      }
    }
  }
}

/**
 * Compute gate status and per-pillar health from the current results.
 * @param {Map<string, NodeResult>} results
 * @returns {{ gateStatus: string; blockReason: string|null; failingOwnScore: number; failurePct: number; pillarHealth: Record<string, number> }}
 */
function computeGate(results) {
  let gateStatus = 'SAFE'
  let blockReason = null
  let failingOwnScore = 0

  // Per-pillar passing OwnScore accumulators
  const pillarPassing = Object.fromEntries(Object.keys(PILLARS).map(k => [k, 0]))

  for (const node of NODES) {
    const result = results.get(node.id)
    const status = result?.status ?? 'skipped'
    const pillar = PILLARS[node.pillar]

    if (status === 'failed' || status === 'correlated') {
      // Zero-tolerance check
      if (pillar.zeroTolerance && gateStatus !== 'HARD_BLOCK') {
        gateStatus = 'HARD_BLOCK'
        blockReason = `Zero-tolerance pillar failure: ${node.pillar} (${node.id} — ${node.label})`
      }
      // Score-gated accumulation (unique own score, not failure cost)
      if (status === 'failed') {
        failingOwnScore += node.ownScore
      }
    } else {
      // Passed, flaky, or skipped — counts as passing for pillar health
      if (status !== 'skipped') {
        pillarPassing[node.pillar] += node.ownScore
      }
    }
  }

  const failurePct = (failingOwnScore / SUITE.totalOwnScore) * 100

  if (gateStatus !== 'HARD_BLOCK') {
    if (failurePct > 10) {
      gateStatus = 'BLOCKED'
      blockReason = `Score gate exceeded: ${failurePct.toFixed(1)}% > 10% threshold`
    } else if (failurePct > 5) {
      gateStatus = 'WARNING'
      blockReason = `Score gate warning: ${failurePct.toFixed(1)}% > 5% threshold — PE review required`
    }
  }

  const pillarHealth = {}
  for (const [key, pillar] of Object.entries(PILLARS)) {
    pillarHealth[key] = Math.round((pillarPassing[key] / pillar.ownScoreTotal) * 100)
  }

  return { gateStatus, blockReason, failingOwnScore, failurePct, pillarHealth }
}

/**
 * Build the full suite-graph.json report object.
 * @param {Map<string, NodeResult>} results
 * @param {number} durationMs - total suite duration
 * @returns {object}
 */
function buildReport(results, durationMs) {
  const { gateStatus, blockReason, failingOwnScore, failurePct, pillarHealth } = computeGate(results)

  // Build edge lookup for node-level annotation
  const edgesBySource = new Map()
  const edgesByTarget = new Map()
  for (const edge of EDGES) {
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, [])
    edgesBySource.get(edge.source).push(edge.target)
    if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
    edgesByTarget.get(edge.target).push(edge.source)
  }

  const nodes = NODES.map(node => {
    const result = results.get(node.id) ?? { status: 'skipped', durationMs: 0, errors: [], correlatedFrom: null }
    return {
      id:             node.id,
      label:          node.label,
      journey:        node.journey,
      pillar:         node.pillar,
      zeroTolerance:  PILLARS[node.pillar].zeroTolerance,
      ownScore:       node.ownScore,
      failureCost:    node.failureCost,
      leafCount:      node.leafCount,
      frequencyTier:  node.frequencyTier,
      criticality:    node.criticality,
      detectionLag:   node.detectionLag,
      status:         result.status,
      durationMs:     result.durationMs,
      correlatedFrom: result.correlatedFrom ?? null,
      correlatesTo:   edgesBySource.get(node.id) ?? [],
      correlatedBy:   edgesByTarget.get(node.id) ?? [],
      specFile:       node.specFile,
      journeyFile:    node.journeyFile,
      logs:           result.errors.length > 0 ? result.errors : null,
    }
  })

  // Build fix queue — sort failing+correlated by failureCost desc
  const fixQueue = nodes
    .filter(n => n.status === 'failed' || n.status === 'correlated')
    .sort((a, b) => b.failureCost - a.failureCost)
    .map((n, i) => ({
      rank:                i + 1,
      scenarioId:          n.id,
      name:                n.label,
      journey:             n.journey,
      ownScore:            n.ownScore,
      fixPriorityScore:    n.failureCost,
      gate:                n.zeroTolerance ? 'HARD_BLOCK' : 'score-gated',
      pillar:              n.pillar,
      status:              n.status,
      correlatedFrom:      n.correlatedFrom,
      correlatesTo:        n.correlatesTo,
      sharedCodePath:      EDGES.find(e => e.source === n.id)?.sharedCodePath ?? null,
      specFile:            n.specFile,
      journeyFile:         n.journeyFile,
    }))

  const counts = { passed: 0, flaky: 0, failed: 0, correlated: 0, skipped: 0 }
  for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1

  return {
    suiteVersion:      SUITE.version,
    timestamp:         new Date().toISOString(),
    durationMs,
    totalOwnScore:     SUITE.totalOwnScore,
    gateThreshold10:   SUITE.gateThreshold10pct,
    gateThreshold5:    SUITE.gateThreshold5pct,
    deploymentStatus:  gateStatus,
    blockReason,
    scoreGate: {
      failingOwnScore: Math.round(failingOwnScore),
      failurePct:      Math.round(failurePct * 10) / 10,
      status:          gateStatus === 'SAFE' ? 'SAFE' : gateStatus === 'WARNING' ? 'WARNING' : 'BLOCKED',
    },
    pillarHealth,
    counts,
    nodes,
    edges: EDGES.map(e => ({ source: e.source, target: e.target, sharedCodePath: e.sharedCodePath })),
    fixQueue,
  }
}

// ─── Playwright Reporter class ────────────────────────────────────────────────

/**
 * @typedef {{ status: string; durationMs: number; errors: object[]; correlatedFrom: string|null }} NodeResult
 */

export default class GraphReporter {
  constructor() {
    /** @type {Map<string, NodeResult>} */
    this._results = new Map()
    this._suiteStartMs = 0
  }

  /**
   * @param {import('@playwright/test/reporter').FullConfig} _config
   * @param {import('@playwright/test/reporter').Suite} _suite
   */
  onBegin(_config, _suite) {
    this._suiteStartMs = Date.now()

    // Pre-populate every scenario as 'skipped'
    for (const node of NODES) {
      this._results.set(node.id, { status: 'skipped', durationMs: 0, errors: [], correlatedFrom: null })
    }
  }

  /**
   * @param {import('@playwright/test/reporter').TestCase} test
   * @param {import('@playwright/test/reporter').TestResult} result
   */
  onTestEnd(test, result) {
    const titlePath = test.titlePath()
    const scenarioId = extractScenarioId(titlePath)
    if (!scenarioId) return   // not a tagged scenario — ignore

    const current = this._results.get(scenarioId)
    if (!current) return      // unknown scenario ID — ignore (spec bug)

    const incoming = toNodeStatus(result.status, result.retry)
    current.status = worstStatus(current.status, incoming)
    current.durationMs += result.duration
    current.errors.push(...extractErrors(result))
  }

  /**
   * @param {import('@playwright/test/reporter').FullResult} _result
   */
  onEnd(_result) {
    propagateCorrelations(this._results)

    const durationMs = Date.now() - this._suiteStartMs
    const report = buildReport(this._results, durationMs)

    mkdirSync('test-results', { recursive: true })
    const outPath = join('test-results', 'suite-graph.json')
    writeFileSync(outPath, JSON.stringify(report, null, 2))

    // Console summary
    const { deploymentStatus, scoreGate, counts } = report
    const statusEmoji = {
      SAFE: '✅', WARNING: '⚠️', BLOCKED: '🚫', HARD_BLOCK: '🛑'
    }[deploymentStatus] ?? '❓'

    console.log(`\n${statusEmoji}  Gate: ${deploymentStatus}  |  ` +
      `Fail score: ${scoreGate.failingOwnScore}/${SUITE.totalOwnScore} (${scoreGate.failurePct}%)`)
    console.log(`   passed:${counts.passed}  flaky:${counts.flaky}  failed:${counts.failed}  ` +
      `correlated:${counts.correlated}  skipped:${counts.skipped}`)
    console.log(`   📊  Graph report → ${outPath}`)
    if (report.blockReason) {
      console.log(`   ⚠️   ${report.blockReason}`)
    }
    if (report.fixQueue.length > 0) {
      console.log(`   Fix #1: ${report.fixQueue[0].scenarioId} — ${report.fixQueue[0].name}` +
        ` (FailureCost ${report.fixQueue[0].fixPriorityScore})`)
    }
  }
}
