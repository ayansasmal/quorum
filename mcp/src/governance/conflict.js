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
 * The LLM call uses OPENAI_API_KEY directly (not via Graphiti).
 * Graphiti has its own LLM for entity extraction — Quorum uses its own
 * for conflict detection to keep the concerns separate.
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
import { loadPrompt } from '../prompts/loader.js'

const DEFAULT_CONFLICT_THRESHOLD = parseFloat(process.env.QUORUM_CONFLICT_THRESHOLD ?? '0.85')
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const LLM_MODEL = process.env.LLM_MODEL_NAME ?? 'gpt-4o-mini'

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
 * Ask the LLM whether two pieces of knowledge contradict each other,
 * and whether they might actually be different scenarios rather than a true conflict.
 * Returns structured JSON so the reviewer sees the split signal prominently.
 *
 * @param {string} existing
 * @param {string} incoming
 * @returns {Promise<{ contradicts: boolean, reason: string, possible_split: boolean, split_suggestion?: string }>}
 */
async function checkContradiction(existing, incoming) {
  if (!OPENAI_API_KEY) {
    return {
      contradicts: true,
      reason: 'LLM not configured — flagging for human review',
      possible_split: false,
    }
  }

  const { system, user } = loadPrompt('check-contradiction.md', { existing, incoming })

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    return {
      contradicts: true,
      reason: `LLM check failed (${response.status}) — flagging for human review`,
      possible_split: false,
    }
  }

  try {
    const data = await response.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    const possibleSplit = Boolean(parsed.possible_split)
    return {
      contradicts: Boolean(parsed.contradicts),
      reason: parsed.reason ?? '',
      possible_split: possibleSplit,
      split_suggestion: possibleSplit ? (parsed.split_suggestion ?? null) : null,
    }
  } catch {
    return {
      contradicts: true,
      reason: 'LLM response unparseable — flagging for human review',
      possible_split: false,
    }
  }
}

/**
 * Generate reviewer enrichment via LLM — called at conflict creation time,
 * stored in pending_decisions.enrichment so reviewers get instant analysis.
 *
 * @param {string} existing
 * @param {string} incoming
 * @param {string} conflictReason
 * @param {boolean} possibleSplit
 * @param {string | undefined} splitSuggestion
 * @returns {Promise<Record<string, unknown>>}
 */
export async function generateEnrichment(existing, incoming, conflictReason, possibleSplit, splitSuggestion) {
  if (!OPENAI_API_KEY) {
    return {
      analysis: 'LLM not configured — manual review required.',
      risks_if_approved: [],
      questions_for_reviewer: ['Is the incoming knowledge correct in this context?'],
      existing_rationale: null,
      possible_split: possibleSplit,
      split_suggestion: splitSuggestion ?? null,
    }
  }

  const splitNote = possibleSplit
    ? `\nThe contradiction detector flagged that these may actually describe different scenarios. Suggested scoping: "${splitSuggestion}"`
    : ''
  const { system, user } = loadPrompt('generate-enrichment.md', {
    existing,
    incoming,
    conflictReason,
    splitNote,
  })

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 500,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    // Clamp array lengths to the bounds stated in the prompt so a non-compliant
    // model response never silently passes through with 0 or 10 items.
    const risks = Array.isArray(parsed.risks_if_approved) ? parsed.risks_if_approved : []
    const questions = Array.isArray(parsed.questions_for_reviewer) ? parsed.questions_for_reviewer : []
    return {
      ...parsed,
      risks_if_approved:        risks.slice(0, 4).length >= 2 ? risks.slice(0, 4) : risks.slice(0, 4).concat(Array(Math.max(0, 2 - risks.length)).fill('Review this aspect carefully before deciding.')),
      questions_for_reviewer:   questions.slice(0, 3).length >= 2 ? questions.slice(0, 3) : questions.slice(0, 3).concat(Array(Math.max(0, 2 - questions.length)).fill('Is the incoming knowledge correct in this context?')),
    }
  } catch (err) {
    console.error(`[Quorum:conflict] Enrichment LLM call failed: ${err.message}`)
    return {
      analysis: 'Enrichment unavailable — LLM call failed.',
      risks_if_approved: [],
      questions_for_reviewer: ['Review both entries manually before deciding.'],
      existing_rationale: null,
      possible_split: possibleSplit,
      split_suggestion: splitSuggestion ?? null,
    }
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
 * @returns {Promise<ConflictResult>}
 */
export async function detectConflict(newContent, topic, key, domain) {
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
