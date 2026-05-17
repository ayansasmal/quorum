/**
 * Conflict detection and resolution.
 *
 * Flow:
 *   1. searchNodes() — find semantically similar existing knowledge
 *   2. For similarity > CONFLICT_THRESHOLD (domain-specific or global): LLM contradiction check
 *   3. If contradiction confirmed: authority comparison
 *   4. If delta > AUTHORITY_THRESHOLD: auto-supersede + notify
 *   5. Else: return structured decision brief for human resolution
 *
 * LLM calls are delegated to the gateway via POST /governance/detect-conflict
 * and POST /governance/enrich. The MCP never calls OpenAI directly.
 *
 * Resolution options (v0.2):
 *   supersede      — incoming replaces existing entirely
 *   coexist_split  — reviewer forks into two scoped topic:keys (different scenarios)
 *   coexist_merge  — reviewer writes a single combined entry covering both contexts
 *   reject         — incoming is wrong; existing stands
 *   escalate       — needs wider team discussion
 *
 * Tags (v0.2):
 *   All tags are normalized (lowercase + trim) before storage and lookup.
 *   normalizeTags() is exported for use in remember() and recall().
 */

import { searchNodes } from '../graph/client.js'
import { calculateAuthority, shouldAutoSupersede } from './authority.js'
import { getConfig } from '../config/loader.js'

const DEFAULT_CONFLICT_THRESHOLD = parseFloat(process.env.QUORUM_CONFLICT_THRESHOLD ?? '0.85')

// ── Tag normalization ─────────────────────────────────────────────────────────

/**
 * Normalize an array of tags: lowercase + trim each entry, deduplicate, sort.
 * Handles null/undefined gracefully — returns empty array.
 * @param {string[] | null | undefined} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  if (!tags || !Array.isArray(tags)) return []
  return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].sort()
}

// ── Domain threshold lookup ───────────────────────────────────────────────────

/**
 * Get the conflict threshold for a domain.
 * Falls back to the global env var default when domain has no override.
 * @param {string | null | undefined} domain
 * @returns {number}
 */
function getConflictThreshold(domain) {
  if (!domain) return DEFAULT_CONFLICT_THRESHOLD
  try {
    const config = getConfig()
    return config.domains[domain]?.conflict_threshold ?? DEFAULT_CONFLICT_THRESHOLD
  } catch {
    return DEFAULT_CONFLICT_THRESHOLD
  }
}

// ── LLM contradiction check ───────────────────────────────────────────────────

/**
 * Ask the gateway LLM whether two pieces of knowledge contradict each other.
 * Routes to POST /governance/detect-conflict — the gateway owns the LLM key.
 * On any failure, flags for human review rather than silently passing.
 *
 * @param {string} existing
 * @param {string} incoming
 * @param {import('../gateway/client.js').GatewayClient} gw
 * @returns {Promise<{ contradicts: boolean, reason: string, possible_split: boolean, split_suggestion?: string }>}
 */
async function checkContradiction(existing, incoming, gw) {
  try {
    const result = await gw._post('/governance/detect-conflict', { existing, incoming })
    const possibleSplit = Boolean(result.possible_split)
    return {
      contradicts: Boolean(result.contradicts),
      reason: result.reason ?? '',
      possible_split: possibleSplit,
      split_suggestion: possibleSplit ? (result.split_suggestion ?? null) : null,
    }
  } catch (err) {
    const isNotImplemented = err.message?.includes('404') || err.message?.includes('501')
    const reason = isNotImplemented
      ? 'Gateway LLM governance not yet enabled (POST /governance/detect-conflict not found). Flagging for human review — configure OPENAI_API_KEY on the gateway to enable automatic conflict detection.'
      : `Conflict detection unavailable (${err.message}). Flagging for human review.`
    return { contradicts: true, reason, possible_split: false }
  }
}

/**
 * Generate reviewer enrichment via the gateway LLM (POST /governance/enrich).
 * Called at conflict creation time — stored in pending_decisions so reviewers
 * get instant analysis without waiting for an LLM call during review.
 *
 * @param {string} existing
 * @param {string} incoming
 * @param {string} conflictReason
 * @param {boolean} possibleSplit
 * @param {string | undefined} splitSuggestion
 * @param {import('../gateway/client.js').GatewayClient} gw
 * @returns {Promise<Record<string, unknown>>}
 */
export async function generateEnrichment(existing, incoming, conflictReason, possibleSplit, splitSuggestion, gw) {
  const fallback = {
    analysis: 'Enrichment unavailable — gateway LLM not configured (OPENAI_API_KEY not set on the gateway).',
    risks_if_approved: ['Review both entries manually before deciding.'],
    questions_for_reviewer: ['Is the incoming knowledge correct in this context?'],
    existing_rationale: null,
    possible_split: possibleSplit,
    split_suggestion: splitSuggestion ?? null,
  }

  try {
    const result = await gw._post('/governance/enrich', {
      existing,
      incoming,
      conflict_reason: conflictReason,
      possible_split: possibleSplit,
      split_suggestion: splitSuggestion ?? null,
    })
    return { ...fallback, ...result }
  } catch (err) {
    console.error(`[Quorum:conflict] Enrichment unavailable: ${err.message}`)
    return fallback
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ConflictResult
 * @property {boolean} conflict
 * @property {Record<string, unknown>} [existing] - the conflicting node
 * @property {string} [reason] - why it conflicts
 * @property {number} [similarity] - similarity score that triggered the check
 * @property {boolean} [possible_split] - LLM suspects these are different scenarios, not a true conflict
 * @property {string} [split_suggestion] - how to scope each if splitting
 */

/**
 * Detect whether new content conflicts with existing knowledge.
 * Uses the domain-specific conflict threshold when available.
 * Returns { conflict: false } if no conflict detected.
 *
 * @param {string} newContent
 * @param {string} topic
 * @param {string} key
 * @param {string} [domain] - domain name for per-domain threshold lookup
 * @param {import('../gateway/client.js').GatewayClient} [gw]
 * @returns {Promise<ConflictResult>}
 */
export async function detectConflict(newContent, topic, key, domain, gw) {
  const conflictThreshold = getConflictThreshold(domain)

  let searchResult
  try {
    searchResult = await searchNodes(newContent, { limit: 5 })
  } catch {
    // GAP-03: Graphiti unavailable — signal caller to store with PENDING_CONFLICT_CHECK status.
    // Do NOT silently skip: a skipped conflict check is a governance failure.
    return { conflict: false, graphiti_unavailable: true }
  }

  const nodes = searchResult?.nodes ?? []

  for (const node of nodes) {
    const similarity = node.score ?? node.similarity ?? 0

    if (similarity < conflictThreshold) continue

    // Skip if this is the same topic:key (updating own knowledge is not a conflict)
    const nodeKey = node.metadata?.key ?? node.name ?? ''
    if (nodeKey === `${topic}:${key}`) continue

    const result = await checkContradiction(
      node.summary ?? node.content ?? JSON.stringify(node),
      newContent,
      gw,
    ).catch(() => ({ contradicts: false, reason: '', possible_split: false }))

    if (result.contradicts) {
      return {
        conflict: true,
        existing: node,
        reason: result.reason,
        similarity,
        possible_split: result.possible_split,
        split_suggestion: result.split_suggestion,
      }
    }
  }

  return { conflict: false }
}

/**
 * @typedef {Object} ResolutionResult
 * @property {'auto_supersede' | 'human_required'} action
 * @property {Record<string, unknown>} [brief] - decision brief (when human_required)
 * @property {string} [reason] - auto-supersede reason (when auto_supersede)
 */

/**
 * Given a confirmed conflict, decide whether to auto-supersede or escalate to human.
 *
 * @param {{ confidence?: number, created_at: string, access_count?: number, author?: string, content?: string }} incoming
 * @param {{ confidence?: number, created_at: string, access_count?: number, author?: string, content?: string }} existing
 * @param {string} conflictReason
 * @param {{ possible_split?: boolean, split_suggestion?: string }} [hints] - signals from LLM contradiction check
 * @returns {ResolutionResult}
 */
export function resolveConflict(incoming, existing, conflictReason, hints = {}) {
  if (shouldAutoSupersede(incoming, existing)) {
    return {
      action: 'auto_supersede',
      reason: `Auto-superseded: incoming authority score higher by >${process.env.QUORUM_AUTHORITY_THRESHOLD ?? 0.20}. Conflict: ${conflictReason}`,
    }
  }

  return {
    action: 'human_required',
    brief: buildDecisionBrief(incoming, existing, conflictReason, hints),
  }
}

/**
 * Build a structured conflict decision brief for human review.
 * Includes coexist_split and coexist_merge options so reviewers can fork or
 * combine knowledge that the LLM conflated as a contradiction.
 * The `possible_split` flag from the LLM is surfaced prominently so reviewers
 * don't miss the case where both entries are valid in different scenarios.
 *
 * Resolution options:
 *   supersede      — incoming replaces existing (reason required)
 *   coexist_split  — reviewer forks into two scoped topic:keys
 *   coexist_merge  — reviewer writes a single combined entry
 *   reject         — incoming is wrong; existing stands (reason required)
 *   escalate       — needs wider architecture discussion
 *
 * @param {Record<string, unknown>} incoming
 * @param {Record<string, unknown>} existing
 * @param {string} conflictReason
 * @param {{ possible_split?: boolean, split_suggestion?: string }} hints
 * @returns {Record<string, unknown>}
 */
function buildDecisionBrief(incoming, existing, conflictReason, hints = {}) {
  return {
    type: 'conflict_decision_required',
    existing: {
      content: existing.summary ?? existing.content,
      author: existing.metadata?.author ?? existing.author,
      created_at: existing.created_at,
      confidence: existing.metadata?.confidence ?? existing.confidence ?? 0.5,
      authority_score: calculateAuthority(existing),
    },
    incoming: {
      content: incoming.content,
      author: incoming.author,
      confidence: incoming.confidence ?? 0.7,
      authority_score: calculateAuthority({ ...incoming, created_at: new Date().toISOString() }),
    },
    conflict_reason: conflictReason,
    // Prominent signal when the LLM suspects a scope difference rather than a true conflict.
    // Reviewers should check this first — if true, coexist_split is likely the right action.
    possible_split: hints.possible_split ?? false,
    split_suggestion: hints.split_suggestion ?? null,
    options: [
      {
        id: 'supersede',
        label: 'Supersede existing — incoming replaces it entirely (reason required)',
      },
      {
        id: 'coexist_split',
        label: 'Fork into two scoped entries — both are valid for different scenarios (provide new keys + optional refined content)',
        requires: ['split_existing_key', 'split_incoming_key'],
      },
      {
        id: 'coexist_merge',
        label: 'Merge into one combined entry — write a unified version covering both contexts (provide merged_content)',
        requires: ['merged_content'],
      },
      {
        id: 'reject',
        label: 'Reject incoming — existing knowledge stands (reason required)',
      },
      {
        id: 'escalate',
        label: 'Escalate — needs wider architecture discussion before deciding',
      },
    ],
  }
}
