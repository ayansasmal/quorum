/**
 * graph-reporter.js — Playwright custom reporter for the Quorum E2E suite.
 *
 * Outputs test-results/suite-graph.json after every run. The JSON encodes
 * the full 31-node DAG with live pass/fail/skip status overlaid on the
 * static OwnScore + FailureCost values from graph-schema.js.
 *
 * Registration in playwright.config.js:
 *   reporter: [['./reporter/graph-reporter.js']]
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
 *
 * null is used as the "not-yet-seen" sentinel in onBegin and maps to rank 0
 * (below every real status). This ensures that any real test result — even
 * `passed` — overrides the initial null, so scenarios with all-passing tests
 * correctly surface as `passed` rather than remaining at the initial value.
 *
 * @param {string|null} a
 * @param {string|null} b
 * @returns {string|null}
 */
function worstStatus(a, b) {
  const rank = { failed: 5, correlated: 4, flaky: 3, skipped: 2, passed: 1 }
  // null → 0: any real status wins over the uninitialised sentinel
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

      // Mark correlated only if the target's own tests didn't fail independently.
      // null (not yet seen) is treated the same as skipped here — it means the
      // scenario has no independent failure and can be attributed to the source.
      if (target.status === null || target.status === 'passed' || target.status === 'skipped' || target.status === 'flaky') {
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
    // Resolve null sentinel to 'skipped' for gate computation
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
    const result = results.get(node.id) ?? { status: null, durationMs: 0, errors: [], correlatedFrom: null }
    // Resolve null sentinel (no tests ran for this scenario) to 'skipped' for output.
    const effectiveStatus = result.status ?? 'skipped'
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
      status:         effectiveStatus,
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

    // Pre-populate every scenario with null status (sentinel = "not yet seen").
    // worstStatus(null, anyRealStatus) always returns anyRealStatus because
    // null maps to rank 0, below every named status. Scenarios that receive no
    // test results are resolved to 'skipped' in buildReport at emit time.
    for (const node of NODES) {
      this._results.set(node.id, { status: null, durationMs: 0, errors: [], correlatedFrom: null })
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
    console.log(`   📊  Graph JSON  → ${jsonPath}`)
    console.log(`   🌐  Graph HTML  → ${htmlPath}`)
    console.log(`   💡  Open in browser: open ${htmlPath}  (or: npm run test:e2e:graph)`)
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
 * Pillar → border colour for Cytoscape nodes and the HTML legend.
 * Each pillar gets a distinct vivid colour visible against the dark background.
 */
const PILLAR_COLOR = {
  governance_integrity:    '#a78bfa',  // violet-400
  security:                '#f87171',  // red-400
  data_integrity:          '#34d399',  // emerald-400
  functional_correctness:  '#60a5fa',  // blue-400
  federation:              '#818cf8',  // indigo-400
  operational_reliability: '#fbbf24',  // amber-400
  observability:           '#2dd4bf',  // teal-400
  developer_experience:    '#fb923c',  // orange-400
}

/**
 * Generates a self-contained HTML file embedding the full report as JSON and
 * a Cytoscape.js DAG visualisation of the scenario correlation graph.
 *
 * Cytoscape 3.33.4 is loaded from the unpkg CDN (requires internet when opening
 * the report). If the CDN is unavailable the graph panel shows a text fallback
 * but all table-based content remains fully functional.
 *
 * All client-side JS uses DOM methods (createElement / textContent / appendChild)
 * instead of innerHTML so that error messages from Playwright are handled safely
 * regardless of their content.
 *
 * @param {object} report - the report object from buildReport()
 * @returns {string} complete HTML document
 */
function generateHtml(report) {
  const { deploymentStatus, scoreGate, counts, pillarHealth, fixQueue, nodes, edges, timestamp, durationMs } = report

  const gateColor = {
    SAFE: '#22c55e', WARNING: '#f59e0b', BLOCKED: '#ef4444', HARD_BLOCK: '#dc2626',
  }[deploymentStatus] ?? '#94a3b8'

  const durationSec = (durationMs / 1000).toFixed(1)
  const ts          = new Date(timestamp).toLocaleString()

  // ── Fix queue rows ────────────────────────────────────────────────────────
  const fixRows = fixQueue.map(f => `
    <tr>
      <td>${f.rank}</td>
      <td><span class="badge" style="background:${STATUS_COLOR[f.status] ?? '#94a3b8'}">${f.status}</span></td>
      <td><strong>${f.scenarioId}</strong></td>
      <td>${f.name}</td>
      <td>${f.pillar}</td>
      <td style="text-align:right">${f.fixPriorityScore}</td>
      <td>${f.specFile ? f.specFile.replace(/^e2e\/scenarios\/(?:api|ui)\//, '') : '—'}</td>
    </tr>`).join('')

  // ── All-scenarios table rows ──────────────────────────────────────────────
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

  // ── Pillar health bars ────────────────────────────────────────────────────
  const pillarBars = Object.entries(pillarHealth).map(([key, pct]) => {
    const barColor = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444'
    return `
      <div class="pillar-row">
        <span class="pillar-name">${key.replace(/_/g, ' ')}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <span class="pillar-pct">${pct}%</span>
      </div>`
  }).join('')

  // ── Graph legend chips ────────────────────────────────────────────────────
  const statusLegend = Object.entries(STATUS_COLOR).map(([s, c]) =>
    `<div class="legend-chip"><div class="legend-swatch" style="background:${c}"></div>${s}</div>`
  ).join('')

  const pillarLegend = Object.entries(PILLAR_COLOR).map(([p, c]) =>
    `<div class="legend-chip"><div class="legend-ring" style="border-color:${c}"></div>${p.replace(/_/g, ' ')}</div>`
  ).join('')

  // ── Embed report data as safe inline JSON ─────────────────────────────────
  // Escape the closing tag so the literal is safe inside a <script> block.
  const safeJson = v => JSON.stringify(v).replace(/<\/script>/gi, '<\\/script>')

  const cyNodes = safeJson(nodes.map(n => ({
    id:             n.id,
    fullLabel:      n.label,
    journey:        n.journey,
    pillar:         n.pillar,
    status:         n.status,
    ownScore:       n.ownScore,
    failureCost:    n.failureCost,
    leafCount:      n.leafCount,
    zeroTolerance:  n.zeroTolerance,
    durationMs:     n.durationMs,
    correlatesTo:   n.correlatesTo,
    correlatedBy:   n.correlatedBy,
    correlatedFrom: n.correlatedFrom,
    logs:           n.logs,
    specFile:       n.specFile,
  })))

  const cyEdges = safeJson(edges.map(e => ({
    source:         e.source,
    target:         e.target,
    sharedCodePath: e.sharedCodePath,
  })))

  // Primary run node — embedded metadata for the run hub shown in the graph.
  const cyRunNode = safeJson({
    timestamp:       report.timestamp,
    gateStatus:      deploymentStatus,
    gateColor,
    passed:          counts.passed,
    flaky:           counts.flaky,
    failed:          counts.failed,
    correlated:      counts.correlated,
    skipped:         counts.skipped,
    failingOwnScore: scoreGate.failingOwnScore,
    totalOwnScore:   report.totalOwnScore,
    failurePct:      scoreGate.failurePct,
    durationMs,
    suiteVersion:    report.suiteVersion,
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quorum E2E Suite Graph — ${deploymentStatus}</title>
<script src="https://unpkg.com/cytoscape@3.33.4/dist/cytoscape.min.js"><\/script>
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
  th { background: #0f172a; padding: 8px 10px; text-align: left; font-size: 12px; color: #94a3b8; position: sticky; top: 0; }
  td { padding: 7px 10px; border-bottom: 1px solid #0f172a; vertical-align: top; font-size: 13px; }
  tr:hover td { background: #1e293b88; }
  .err { color: #fca5a5; font-size: 11px; font-family: monospace; margin-top: 2px; white-space: pre-wrap; word-break: break-all; }
  .section { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 20px; overflow-x: auto; }
  .pillar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .pillar-name { width: 200px; font-size: 12px; color: #94a3b8; flex-shrink: 0; text-transform: capitalize; }
  .bar-bg { flex: 1; height: 10px; background: #334155; border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5px; }
  .pillar-pct { width: 36px; text-align: right; font-size: 12px; font-weight: 600; }
  .score-line { font-size: 13px; margin-bottom: 12px; }
  .score-line span { font-weight: 700; color: ${gateColor}; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Graph canvas ──────────────────────────────────────────────────────── */
  #cy { height: 500px; width: 100%; background: #080f1e; border-radius: 6px; cursor: grab; }
  #cy:active { cursor: grabbing; }
  .graph-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .ctrl-btn { padding: 4px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #94a3b8; font-size: 12px; cursor: pointer; user-select: none; }
  .ctrl-btn:hover { background: #334155; color: #e2e8f0; }
  .graph-hint { font-size: 11px; color: #475569; margin-left: 6px; }
  .graph-legend { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #334155; }
  .legend-group { display: flex; flex-direction: column; gap: 6px; }
  .legend-title { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .08em; }
  .legend-items { display: flex; flex-wrap: wrap; gap: 8px; }
  .legend-chip { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #94a3b8; }
  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
  .legend-ring { width: 13px; height: 13px; border-radius: 3px; border: 3px solid; flex-shrink: 0; }

  /* ── Node detail panel ─────────────────────────────────────────────────── */
  #node-detail { display: none; margin-top: 14px; padding: 14px 16px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; }
  .detail-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .detail-id { font-size: 16px; font-weight: 700; }
  .detail-lbl { font-size: 13px; color: #94a3b8; }
  .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 24px; font-size: 12px; margin: 10px 0; }
  .detail-cell > span { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 1px; }
  .detail-spec { font-size: 11px; color: #475569; margin-top: 6px; font-family: monospace; }
  .detail-err { margin-top: 10px; }
  .detail-cor { font-size: 12px; color: #f97316; margin-top: 6px; }
</style>
</head>
<body>

<h1>Quorum E2E Suite Graph</h1>
<div class="meta">${ts} &nbsp;&middot;&nbsp; ${durationSec}s &nbsp;&middot;&nbsp; ${nodes.length} scenarios</div>

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
  &nbsp;&middot;&nbsp; gate at 5% (warning) / 10% (blocked)
</div>

<h2>Dependency Graph</h2>
<div class="section">
  <div class="graph-controls">
    <button class="ctrl-btn" id="btn-fit">Fit</button>
    <button class="ctrl-btn" id="btn-zoomin">+</button>
    <button class="ctrl-btn" id="btn-zoomout">−</button>
    <span class="graph-hint">Scroll to zoom · drag to pan · click node for details · click background to dismiss</span>
  </div>
  <div id="cy"></div>
  <div class="graph-legend">
    <div class="legend-group">
      <div class="legend-title">Status (fill)</div>
      <div class="legend-items">${statusLegend}</div>
    </div>
    <div class="legend-group">
      <div class="legend-title">Pillar (border)</div>
      <div class="legend-items">${pillarLegend}</div>
    </div>
  </div>
  <div id="node-detail"></div>
</div>

<h2>Pillar Health</h2>
<div class="section" style="max-width:640px">${pillarBars}</div>

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

<script>
(function () {
  // ── Embedded report data ──────────────────────────────────────────────
  var _nodes = ${cyNodes};
  var _edges = ${cyEdges};
  var _run   = ${cyRunNode};

  // ── Colour maps — must mirror the server-side constants ───────────────
  var SC = { passed:'#22c55e', flaky:'#f59e0b', failed:'#ef4444', correlated:'#f97316', skipped:'#94a3b8' };
  var PC = {
    governance_integrity:'#a78bfa', security:'#f87171', data_integrity:'#34d399',
    functional_correctness:'#60a5fa', federation:'#818cf8', operational_reliability:'#fbbf24',
    observability:'#2dd4bf', developer_experience:'#fb923c',
  };

  // ── Helper: create an element with optional class, style, text ────────
  function el(tag, opts, txt) {
    var e = document.createElement(tag);
    if (opts && opts.cls)   e.className    = opts.cls;
    if (opts && opts.style) e.style.cssText = opts.style;
    if (txt !== undefined)  e.textContent  = txt;
    return e;
  }

  // ── Graceful degradation when CDN script failed to load ───────────────
  if (typeof cytoscape === 'undefined') {
    var cyEl = document.getElementById('cy');
    cyEl.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px';
    cyEl.appendChild(el('span', {style:'color:#64748b;font-size:13px'}, 'Cytoscape.js could not be loaded.'));
    cyEl.appendChild(el('span', {style:'color:#475569;font-size:11px'}, 'Open this file in a browser with internet access to view the graph.'));
    return;
  }

  // ── Build Cytoscape element list ──────────────────────────────────────
  var elems = [];
  _nodes.forEach(function (n) {
    elems.push({ group:'nodes', data:{
      id:            n.id,
      status:        n.status,
      statusColor:   SC[n.status]   || '#334155',
      pillarColor:   PC[n.pillar]   || '#475569',
      fullLabel:     n.fullLabel,
      journey:       n.journey,
      pillar:        n.pillar,
      ownScore:      n.ownScore,
      failureCost:   n.failureCost,
      leafCount:     n.leafCount,
      zeroTolerance: n.zeroTolerance,
      durationMs:    n.durationMs,
      correlatesTo:  n.correlatesTo,
      correlatedBy:  n.correlatedBy,
      correlatedFrom:n.correlatedFrom,
      logs:          n.logs,
      specFile:      n.specFile,
    }});
  });
  _edges.forEach(function (e) {
    elems.push({ group:'edges', data:{
      id: e.source + '__' + e.target,
      source: e.source, target: e.target,
      sharedCodePath: e.sharedCodePath,
    }});
  });

  // ── Primary run node ──────────────────────────────────────────────────
  // Build a short label: YYYY-MM-DD / HH:MM:SS / gate-status (Cytoscape
  // renders \n as a line break when text-wrap is set to 'wrap').
  var _runDate = new Date(_run.timestamp);
  var _pad = function (n) { return String(n).padStart(2, '0'); };
  var _runLabel = _runDate.getFullYear() + '-' + _pad(_runDate.getMonth() + 1) + '-' + _pad(_runDate.getDate())
    + '\n' + _pad(_runDate.getHours()) + ':' + _pad(_runDate.getMinutes()) + ':' + _pad(_runDate.getSeconds())
    + '\n' + _run.gateStatus;
  elems.push({ group: 'nodes', data: {
    id:             '__run__',
    type:           'run',
    label:          _runLabel,
    gateColor:      _run.gateColor,
    gateStatus:     _run.gateStatus,
    passed:         _run.passed,
    flaky:          _run.flaky,
    failed:         _run.failed,
    correlated:     _run.correlated,
    skipped:        _run.skipped,
    failingOwnScore:_run.failingOwnScore,
    totalOwnScore:  _run.totalOwnScore,
    failurePct:     _run.failurePct,
    durationMs:     _run.durationMs,
    suiteVersion:   _run.suiteVersion,
  }});
  // Thin dashed spoke from run hub → every scenario node
  _nodes.forEach(function (n) {
    elems.push({ group: 'edges', data: {
      id: '__run__-' + n.id, source: '__run__', target: n.id, type: 'run',
    }});
  });

  // ── Initialise Cytoscape ──────────────────────────────────────────────
  var cy = window._cy = cytoscape({
    container: document.getElementById('cy'),
    elements:  elems,
    style: [
      { selector:'node', style:{
          label:'data(id)', 'text-valign':'center', 'text-halign':'center',
          color:'#f8fafc', 'font-size':11, 'font-weight':700,
          width:66, height:30, shape:'round-rectangle',
          'background-color':'data(statusColor)',
          'border-color':'data(pillarColor)', 'border-width':3,
      }},
      { selector:'node[status = "skipped"]', style:{ color:'#475569' }},
      { selector:'node:selected',            style:{ 'border-width':5, 'border-color':'#f8fafc' }},
      { selector:'edge', style:{
          width:2, 'line-color':'#334155', 'target-arrow-color':'#334155',
          'target-arrow-shape':'triangle', 'curve-style':'bezier',
          'arrow-scale':0.85, opacity:0.7,
      }},
      { selector:'edge.lit', style:{
          'line-color':'#64748b', 'target-arrow-color':'#64748b', width:2.5, opacity:1,
      }},
      // Run hub node: ellipse, gate-status fill, white border, multi-line label
      { selector:'node[type = "run"]', style:{
          label:'data(label)', 'text-wrap':'wrap', 'text-max-width':88,
          'background-color':'data(gateColor)', 'border-color':'#f8fafc', 'border-width':2,
          color:'#fff', 'font-size':10, 'font-weight':700,
          width:90, height:50, shape:'ellipse',
          'text-valign':'center', 'text-halign':'center',
      }},
      // Run spoke edges: faint dashed lines, no arrowhead, purely structural
      { selector:'edge[type = "run"]', style:{
          width:1, 'line-color':'#1e293b', 'line-style':'dashed',
          'line-dash-pattern':[3, 6], opacity:0.3,
          'target-arrow-shape':'none',
      }},
    ],
    // cose (Compound Spring Embedder) handles disconnected components naturally:
    // spring forces pull linked nodes together while node repulsion spreads
    // isolated nodes. randomize:false gives deterministic output across runs.
    layout:{
      name:'cose', fit:true, padding:40, randomize:false, animate:false,
      componentSpacing:90, nodeRepulsion:450000, nodeOverlap:20,
      idealEdgeLength:110, edgeElasticity:90, nestingFactor:5,
      gravity:70, numIter:1000, initialTemp:220, coolingFactor:0.95, minTemp:1.0,
    },
    minZoom:0.25, maxZoom:4,
    userZoomingEnabled:true, userPanningEnabled:true, boxSelectionEnabled:false,
  });

  // ── Toolbar button wiring ─────────────────────────────────────────────
  document.getElementById('btn-fit').addEventListener('click', function () {
    document.getElementById('node-detail').style.display = 'none';
    cy.fit(undefined, 40);
  });
  document.getElementById('btn-zoomin').addEventListener('click', function () {
    cy.zoom({ level: cy.zoom() * 1.25, renderedPosition:{ x: cy.width()/2, y: cy.height()/2 }});
  });
  document.getElementById('btn-zoomout').addEventListener('click', function () {
    cy.zoom({ level: cy.zoom() / 1.25, renderedPosition:{ x: cy.width()/2, y: cy.height()/2 }});
  });

  // ── Edge highlight on node hover ──────────────────────────────────────
  cy.on('mouseover', 'node', function (evt) { evt.target.connectedEdges('[type != "run"]').addClass('lit'); });
  cy.on('mouseout',  'node', function (evt) { evt.target.connectedEdges('[type != "run"]').removeClass('lit'); });

  // ── Node detail panel — built with DOM methods (no innerHTML) ─────────
  cy.on('tap', 'node', function (evt) {
    var d = evt.target.data();
    var panel = document.getElementById('node-detail');

    // Clear previous content
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.style.display = 'block';

    // ── Run hub node — shows overall run metadata ──────────────────────
    if (d.type === 'run') {
      var hdr = el('div', {cls:'detail-header'});
      hdr.appendChild(el('span', {cls:'badge', style:'background:' + d.gateColor}, d.gateStatus));
      hdr.appendChild(el('span', {cls:'detail-id'}, 'Test Run'));
      var ts = new Date(d.timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      hdr.appendChild(el('span', {cls:'detail-lbl'}, ts));
      panel.appendChild(hdr);

      var grid = el('div', {cls:'detail-grid'});
      var dur = d.durationMs ? (d.durationMs / 1000).toFixed(1) + 's' : '—';
      [
        ['Passed',      String(d.passed)],
        ['Flaky',       String(d.flaky)],
        ['Failed',      String(d.failed)],
        ['Correlated',  String(d.correlated)],
        ['Skipped',     String(d.skipped)],
        ['Fail score',  d.failingOwnScore + ' / ' + d.totalOwnScore + ' (' + d.failurePct + '%)'],
        ['Duration',    dur],
        ['Version',     d.suiteVersion || '—'],
      ].forEach(function (pair) {
        var cell = el('div', {cls:'detail-cell'});
        cell.appendChild(el('span', null, pair[0]));
        cell.appendChild(document.createTextNode(pair[1]));
        grid.appendChild(cell);
      });
      panel.appendChild(grid);
      return;  // done — no further scenario-specific content
    }

    // ── Scenario node ──────────────────────────────────────────────────
    // Header: badge + id + description
    var hdr = el('div', {cls:'detail-header'});
    var badge = el('span', {cls:'badge', style:'background:' + (SC[d.status] || '#94a3b8')}, d.status);
    hdr.appendChild(badge);
    hdr.appendChild(el('span', {cls:'detail-id'}, d.id));
    hdr.appendChild(el('span', {cls:'detail-lbl'}, d.fullLabel || ''));
    panel.appendChild(hdr);

    // Data grid
    var grid = el('div', {cls:'detail-grid'});
    var dur = d.durationMs ? (d.durationMs / 1000).toFixed(2) + 's' : '—';
    var corTo  = d.correlatesTo  && d.correlatesTo.length  ? d.correlatesTo.join(', ')  : '—';
    var corBy  = d.correlatedBy  && d.correlatedBy.length  ? d.correlatedBy.join(', ')  : '—';

    var cells = [
      ['Journey',        d.journey  || '—'],
      ['Pillar',         (d.pillar  || '—').replace(/_/g, ' ')],
      ['Zero-tolerance', d.zeroTolerance ? 'yes 🛑' : 'no'],
      ['Own Score',      d.ownScore    != null ? String(d.ownScore)    : '—'],
      ['Failure Cost',   d.failureCost != null ? String(d.failureCost) : '—'],
      ['Leaf Count',     d.leafCount   != null ? String(d.leafCount)   : '—'],
      ['Duration',       dur],
      ['Correlates to',  corTo],
      ['Correlated by',  corBy],
    ];

    cells.forEach(function (pair) {
      var cell = el('div', {cls:'detail-cell'});
      cell.appendChild(el('span', null, pair[0]));
      cell.appendChild(document.createTextNode(pair[1]));
      grid.appendChild(cell);
    });
    panel.appendChild(grid);

    // Correlated-from warning
    if (d.correlatedFrom) {
      var cf = el('div', {cls:'detail-cor'});
      cf.textContent = '⊘ Status inherited from failed node: ' + d.correlatedFrom;
      panel.appendChild(cf);
    }

    // Spec file path
    if (d.specFile) {
      panel.appendChild(el('div', {cls:'detail-spec'}, d.specFile.replace(/^e2e\/scenarios\/(?:api|ui)\//, '')));
    }

    // Error logs (each line is a textContent assignment — no HTML injection risk)
    if (d.logs && d.logs.length) {
      var errWrap = el('div', {cls:'detail-err'});
      d.logs.forEach(function (entry) {
        errWrap.appendChild(el('div', {cls:'err'}, String(entry.message || '').slice(0, 300)));
      });
      panel.appendChild(errWrap);
    }
  });

  // Dismiss panel when clicking the canvas background
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      document.getElementById('node-detail').style.display = 'none';
    }
  });

})();
<\/script>
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
