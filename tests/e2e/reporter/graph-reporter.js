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

    const jsonPath = join('test-results', 'suite-graph.json')
    writeFileSync(jsonPath, JSON.stringify(report, null, 2))

    const htmlPath = join('test-results', 'suite-graph.html')
    writeFileSync(htmlPath, generateHtml(report))

    // Console summary
    const { deploymentStatus, scoreGate, counts } = report
    const statusEmoji = {
      SAFE: '✅', WARNING: '⚠️', BLOCKED: '🚫', HARD_BLOCK: '🛑'
    }[deploymentStatus] ?? '❓'

    console.log(`\n${statusEmoji}  Gate: ${deploymentStatus}  |  ` +
      `Fail score: ${scoreGate.failingOwnScore}/${SUITE.totalOwnScore} (${scoreGate.failurePct}%)`)
    console.log(`   passed:${counts.passed}  flaky:${counts.flaky}  failed:${counts.failed}  ` +
      `correlated:${counts.correlated}  skipped:${counts.skipped}`)
    console.log(`   📊  Graph report → ${jsonPath}`)
    console.log(`   🌐  HTML report  → ${htmlPath}`)
    if (report.blockReason) {
      console.log(`   ⚠️   ${report.blockReason}`)
    }
    if (report.fixQueue.length > 0) {
      console.log(`   Fix #1: ${report.fixQueue[0].scenarioId} — ${report.fixQueue[0].name}` +
        ` (FailureCost ${report.fixQueue[0].fixPriorityScore})`)
    }
  }
}

// ─── HTML report generator ────────────────────────────────────────────────────

/** Status → background colour (CSS). */
const STATUS_COLOR = {
  passed:     '#22c55e',
  flaky:      '#f59e0b',
  failed:     '#ef4444',
  correlated: '#f97316',
  skipped:    '#94a3b8',
}

/**
 * Generates a self-contained HTML file embedding the full report as JSON.
 * No external dependencies — opens directly from the filesystem.
 *
 * @param {object} report - the report object from buildReport()
 * @returns {string} complete HTML document
 */
function generateHtml(report) {
  const { deploymentStatus, scoreGate, counts, pillarHealth, fixQueue, nodes, timestamp, durationMs } = report

  const gateColor = {
    SAFE: '#22c55e', WARNING: '#f59e0b', BLOCKED: '#ef4444', HARD_BLOCK: '#dc2626',
  }[deploymentStatus] ?? '#94a3b8'

  const durationSec = (durationMs / 1000).toFixed(1)
  const ts          = new Date(timestamp).toLocaleString()

  // Fix queue rows
  const fixRows = fixQueue.map(f => `
    <tr>
      <td>${f.rank}</td>
      <td><span class="badge" style="background:${STATUS_COLOR[f.status] ?? '#94a3b8'}">${f.status}</span></td>
      <td><strong>${f.scenarioId}</strong></td>
      <td>${f.name}</td>
      <td>${f.pillar}</td>
      <td style="text-align:right">${f.fixPriorityScore}</td>
      <td>${f.specFile ? f.specFile.replace('tests/e2e/scenarios/', '') : '—'}</td>
    </tr>`).join('')

  // Node grid rows (all 31 scenarios)
  const nodeRows = nodes.map(n => {
    const color   = STATUS_COLOR[n.status] ?? '#94a3b8'
    const deps    = n.correlatesTo.length > 0 ? n.correlatesTo.join(', ') : '—'
    const errHtml = n.logs
      ? n.logs.map(e => `<div class="err">${escHtml(e.message.slice(0, 200))}</div>`).join('')
      : ''
    return `
    <tr>
      <td><span class="badge" style="background:${color}">${n.status}</span></td>
      <td><strong>${n.id}</strong></td>
      <td>${n.label}</td>
      <td>${n.pillar}</td>
      <td style="text-align:right">${n.ownScore}</td>
      <td style="text-align:right">${n.failureCost}</td>
      <td>${deps}</td>
      <td>${errHtml}</td>
    </tr>`
  }).join('')

  // Pillar health bars
  const pillarBars = Object.entries(pillarHealth).map(([key, pct]) => {
    const barColor = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444'
    return `
      <div class="pillar-row">
        <span class="pillar-name">${key}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <span class="pillar-pct">${pct}%</span>
      </div>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quorum E2E Suite Graph — ${deploymentStatus}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; font-size: 14px; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 15px; font-weight: 600; margin: 24px 0 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 20px; }
  .gate { display: inline-block; padding: 4px 14px; border-radius: 20px; font-weight: 700; font-size: 16px; color: #fff; background: ${gateColor}; margin-bottom: 8px; }
  .counts { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .count-chip { padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { background: #1e293b; padding: 8px 10px; text-align: left; font-size: 12px; color: #94a3b8; position: sticky; top: 0; }
  td { padding: 7px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; font-size: 13px; }
  tr:hover td { background: #1e293b44; }
  .err { color: #fca5a5; font-size: 11px; font-family: monospace; margin-top: 2px; white-space: pre-wrap; word-break: break-all; }
  .section { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 20px; overflow-x: auto; }
  .pillar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .pillar-name { width: 180px; font-size: 12px; color: #94a3b8; flex-shrink: 0; }
  .bar-bg { flex: 1; height: 10px; background: #334155; border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5px; transition: width .3s; }
  .pillar-pct { width: 36px; text-align: right; font-size: 12px; font-weight: 600; }
  .score-line { font-size: 13px; margin-bottom: 12px; }
  .score-line span { font-weight: 700; color: ${gateColor}; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>

<h1>Quorum E2E Suite Graph</h1>
<div class="meta">${ts} &nbsp;·&nbsp; ${durationSec}s &nbsp;·&nbsp; ${nodes.length} scenarios</div>

<div class="gate">${deploymentStatus}</div>
${report.blockReason ? `<div style="color:#fca5a5;margin:6px 0 12px;font-size:13px;">⚠ ${escHtml(report.blockReason)}</div>` : ''}

<div class="counts">
  <span class="count-chip" style="background:#22c55e22;color:#22c55e">✓ ${counts.passed} passed</span>
  <span class="count-chip" style="background:#f59e0b22;color:#f59e0b">~ ${counts.flaky} flaky</span>
  <span class="count-chip" style="background:#ef444422;color:#ef4444">✗ ${counts.failed} failed</span>
  <span class="count-chip" style="background:#f9731622;color:#f97316">⊘ ${counts.correlated} correlated</span>
  <span class="count-chip" style="background:#94a3b822;color:#94a3b8">– ${counts.skipped} skipped</span>
</div>

<div class="score-line">
  Fail score: <span>${scoreGate.failingOwnScore} / ${report.totalOwnScore} (${scoreGate.failurePct}%)</span>
  &nbsp;·&nbsp; gate at 5% (warning) / 10% (blocked)
</div>

<h2>Pillar Health</h2>
<div class="section" style="max-width:600px">${pillarBars}</div>

${fixQueue.length > 0 ? `
<h2>Fix Queue (${fixQueue.length} items)</h2>
<div class="section">
<table>
  <thead><tr><th>#</th><th>Status</th><th>ID</th><th>Name</th><th>Pillar</th><th style="text-align:right">Cost</th><th>Spec</th></tr></thead>
  <tbody>${fixRows}</tbody>
</table>
</div>` : '<h2>Fix Queue</h2><div class="section" style="color:#22c55e">✓ Nothing to fix — all scenarios passed.</div>'}

<h2>All Scenarios (${nodes.length})</h2>
<div class="section">
<table>
  <thead><tr><th>Status</th><th>ID</th><th>Label</th><th>Pillar</th><th style="text-align:right">Own</th><th style="text-align:right">Cost</th><th>Depends on</th><th>Errors</th></tr></thead>
  <tbody>${nodeRows}</tbody>
</table>
</div>

</body>
</html>`
}

/**
 * Escape HTML special characters to prevent XSS in embedded error messages.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
