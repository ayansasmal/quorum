/**
 * Quorum Gateway — Governance LLM endpoints (BL-11).
 *
 * The gateway is the sole component that holds OPENAI_API_KEY.
 * MCP tools route all LLM governance calls here rather than calling OpenAI directly.
 *
 * Routes:
 *   POST /governance/detect-conflict  — contradiction check between two knowledge nodes
 *   POST /governance/enrich           — reviewer brief for a confirmed conflict
 *   POST /governance/extract          — knowledge extraction from a task summary
 *
 * Auth: verifyJwt — the MCP GatewayClient sends a Bearer JWT on every request.
 * No project middleware — governance calls are project-scoped by the JWT claim already.
 */

import { Router }    from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { Errors }    from '../errors.js'
import { callLLM }   from '../llm.js'

const router = Router()

// All governance endpoints require a valid JWT
router.use(verifyJwt)

// ── Prompt builders ────────────────────────────────────────────────────────────

/**
 * Build the contradiction-check prompt.
 * Mirrors the logic of quorum-mcp/src/prompts/check-contradiction.md.
 *
 * @param {string} existing
 * @param {string} incoming
 * @returns {{ system: string, user: string }}
 */
function buildConflictPrompt(existing, incoming) {
  return {
    system: `You are a conservative conflict detector for an engineering knowledge graph. You review two pieces of engineering knowledge and decide whether they contradict each other.

RULES:
- Base your analysis ONLY on the text provided. Do not infer unstated context, invent technical facts, or draw on information outside this prompt.
- Do not consider unstated context or assumptions about what the team "probably meant".
- If you are uncertain whether a contradiction exists, output contradicts: false. False positives waste human reviewer time more than false negatives.
- A true contradiction means one statement must be wrong or obsolete for the other to hold. Different scope is NOT a contradiction.
- If both statements could be simultaneously true for different scenarios/contexts/components, set possible_split: true and contradicts: false.

OUTPUT SCHEMA (return exactly this shape, no extra fields):
{
  "contradicts": boolean,
  "reason": string,
  "possible_split": boolean,
  "split_suggestion": string | null
}

CONSTRAINTS:
- split_suggestion MUST be null (not undefined, not omitted) when possible_split is false.
- Do not add extra fields.
- Do not explain your reasoning outside the JSON.
- Reply with only valid JSON.`,

    user: `Knowledge A (existing):
"${existing}"

Knowledge B (incoming):
"${incoming}"

Decide whether B contradicts A. Return the JSON object as specified.`,
  }
}

/**
 * Build the reviewer enrichment prompt.
 * Mirrors quorum-mcp/src/prompts/generate-enrichment.md.
 *
 * @param {string} existing
 * @param {string} incoming
 * @param {string} conflictReason
 * @param {boolean} possibleSplit
 * @param {string | null} splitSuggestion
 * @returns {{ system: string, user: string }}
 */
function buildEnrichPrompt(existing, incoming, conflictReason, possibleSplit, splitSuggestion) {
  const splitNote = possibleSplit && splitSuggestion
    ? `Split suggestion: ${splitSuggestion}`
    : ''

  return {
    system: `You are an impartial reviewer brief generator for an engineering knowledge conflict. You produce a structured JSON brief that helps a human reviewer decide between two conflicting pieces of knowledge.

RULES:
- Base your analysis ONLY on the text provided. Do not infer unstated context, invent technical facts, or draw on information outside this prompt.
- Be neutral — do not favour either the existing or the incoming knowledge.
- Risks must be SPECIFIC to these two statements. Do not list generic software engineering risks (e.g. "may introduce bugs", "could affect performance").
- Questions must be answerable by someone who knows this codebase. Do not ask abstract or open-ended philosophical questions.
- Set existing_rationale to null if the rationale is not evident from the text provided. Do NOT speculate.

OUTPUT SCHEMA (return exactly this shape, no extra fields):
{
  "analysis": string,
  "risks_if_approved": string[],
  "questions_for_reviewer": string[],
  "existing_rationale": string | null,
  "possible_split": boolean,
  "split_suggestion": string | null
}

CONSTRAINTS:
- risks_if_approved length: 2, 3, or 4 (not fewer, not more).
- questions_for_reviewer length: 2 or 3 (not fewer, not more).
- Do not add extra fields.
- Do not explain your reasoning outside the JSON.
- Reply with only valid JSON.`,

    user: `Existing knowledge:
"${existing}"

Incoming knowledge:
"${incoming}"

Conflict reason:
"${conflictReason}"
${splitNote}
Produce the JSON reviewer brief as specified.`,
  }
}

/**
 * Build the knowledge extraction prompt.
 * Mirrors quorum-mcp/src/prompts/extract-knowledge.md.
 *
 * @param {string} taskSummary
 * @param {string[]} decisionsMade
 * @param {string[]} patternsUsed
 * @returns {{ system: string, user: string }}
 */
function buildExtractPrompt(taskSummary, decisionsMade, patternsUsed) {
  const decisionsBlock = decisionsMade.length > 0
    ? `\nDecisions made:\n${decisionsMade.map((d) => `- ${d}`).join('\n')}`
    : ''
  const patternsBlock = patternsUsed.length > 0
    ? `\nPatterns used:\n${patternsUsed.map((p) => `- ${p}`).join('\n')}`
    : ''

  return {
    system: `You are a conservative knowledge extractor for an engineering knowledge graph. You extract reusable, team-specific engineering knowledge from a completed task summary.

RULES:
- Base your extraction ONLY on the text provided. Do not infer unstated context, invent technical facts, or draw on information outside this prompt.
- Over-extraction is worse than under-extraction. If in doubt, do not extract. Returning zero items is a valid and often correct answer.
- Quality test: ask "If a senior engineer asked 'why did we do X?', would this entry be the answer?" If no, do not extract it.
- Do NOT extract: generic programming concepts, language/framework basics, implementation details of a single function, debugging steps, temporary workarounds you intend to revert, obvious conclusions (e.g. "we used a for-loop"), restatements of the task itself.
- Do NOT extract secrets, credentials, API keys, tokens, passwords, personally identifiable information (PII), or security-sensitive configuration values.
- Extract a maximum of 3 items. Fewer is better when content is thin.

OUTPUT SCHEMA (return exactly this shape, no extra fields):
{
  "items": [
    {
      "topic": string,
      "key": string,
      "content": string,
      "entity_type": string,
      "confidence": number,
      "mode": string
    }
  ]
}

CONSTRAINTS:
- Return a JSON OBJECT with an "items" array. Do not return a bare array.
- items length: 0 to 3 inclusive. Empty array {"items": []} is correct when nothing meets the quality bar.
- topic: one of: auth | api | db | infra | testing | security | payments — or another short domain word if none fit.
- key: kebab-case, specific enough to be unique (e.g. "jwt-refresh-on-expiry", NOT "auth-approach").
- entity_type: one of: Decision | Pattern | Constraint | Runbook | Requirement.
- confidence: 0.35 (generalising from one case) | 0.55 (extracting a pattern) | 0.75 (echoing an explicit decision).
- mode: one of: "echoing" | "extracting" | "generalising" — must align with confidence (0.75→echoing, 0.55→extracting, 0.35→generalising).
- Do not add extra fields at any level.
- Do not explain your reasoning outside the JSON.
- Reply with only valid JSON.`,

    user: `Task summary:
"${taskSummary}"${decisionsBlock}${patternsBlock}
Extract reusable engineering knowledge per the rules. Return the JSON object as specified.`,
  }
}

// ── POST /governance/detect-conflict ──────────────────────────────────────────

/**
 * Ask the LLM whether two knowledge nodes contradict each other.
 *
 * Request:  { existing: string, incoming: string }
 * Response: { contradicts, reason, possible_split, split_suggestion }
 */
router.post('/detect-conflict', async (req, res, next) => {
  const { existing, incoming } = req.body ?? {}

  if (typeof existing !== 'string' || !existing.trim()) {
    return next(Errors.unprocessable('existing is required (non-empty string)'))
  }
  if (typeof incoming !== 'string' || !incoming.trim()) {
    return next(Errors.unprocessable('incoming is required (non-empty string)'))
  }

  try {
    const raw = await callLLM(buildConflictPrompt(existing, incoming))
    const possibleSplit = Boolean(raw.possible_split)
    res.json({
      contradicts:      Boolean(raw.contradicts),
      reason:           typeof raw.reason === 'string' ? raw.reason : '',
      possible_split:   possibleSplit,
      split_suggestion: possibleSplit ? (raw.split_suggestion ?? null) : null,
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /governance/enrich ────────────────────────────────────────────────────

/**
 * Generate a structured reviewer brief for a confirmed conflict.
 *
 * Request:  { existing, incoming, conflict_reason, possible_split, split_suggestion }
 * Response: { analysis, risks_if_approved, questions_for_reviewer, existing_rationale,
 *             possible_split, split_suggestion }
 */
router.post('/enrich', async (req, res, next) => {
  const {
    existing,
    incoming,
    conflict_reason: conflictReason,
    possible_split:  possibleSplit  = false,
    split_suggestion: splitSuggestion = null,
  } = req.body ?? {}

  if (typeof existing !== 'string' || !existing.trim()) {
    return next(Errors.unprocessable('existing is required (non-empty string)'))
  }
  if (typeof incoming !== 'string' || !incoming.trim()) {
    return next(Errors.unprocessable('incoming is required (non-empty string)'))
  }
  if (typeof conflictReason !== 'string' || !conflictReason.trim()) {
    return next(Errors.unprocessable('conflict_reason is required (non-empty string)'))
  }

  try {
    const raw = await callLLM(buildEnrichPrompt(existing, incoming, conflictReason, Boolean(possibleSplit), splitSuggestion ?? null))
    res.json({
      analysis:                typeof raw.analysis === 'string'     ? raw.analysis : '',
      risks_if_approved:       Array.isArray(raw.risks_if_approved)       ? raw.risks_if_approved       : [],
      questions_for_reviewer:  Array.isArray(raw.questions_for_reviewer)  ? raw.questions_for_reviewer  : [],
      existing_rationale:      raw.existing_rationale ?? null,
      possible_split:          Boolean(raw.possible_split),
      split_suggestion:        raw.split_suggestion ?? null,
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /governance/extract ───────────────────────────────────────────────────

/**
 * Extract reusable engineering knowledge from a task summary.
 *
 * Request:  { task_summary, decisions_made?, patterns_used? }
 * Response: { items: ExtractedItem[] }
 */
router.post('/extract', async (req, res, next) => {
  const {
    task_summary:    taskSummary,
    decisions_made:  decisionsMade = [],
    patterns_used:   patternsUsed  = [],
  } = req.body ?? {}

  if (typeof taskSummary !== 'string' || !taskSummary.trim()) {
    return next(Errors.unprocessable('task_summary is required (non-empty string)'))
  }

  try {
    const raw = await callLLM(buildExtractPrompt(
      taskSummary,
      Array.isArray(decisionsMade) ? decisionsMade : [],
      Array.isArray(patternsUsed)  ? patternsUsed  : [],
    ))
    res.json({ items: Array.isArray(raw.items) ? raw.items : [] })
  } catch (err) {
    next(err)
  }
})

export default router
