/**
 * reflect() — Post-task self-evolution tool.
 *
 * Called by Claude Code skill after task completion. Extracts learnable
 * engineering knowledge from a task summary and stores it via remember().
 *
 * All reflected knowledge enters as DRAFT (Claude-authored).
 * Mode is declared: echoing (0.75), extracting (0.55), generalising (0.35).
 *
 * Claude never presents Mode 3 (generalising) as Mode 1 (echoing).
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { TriggeredBy } from '../graph/schema.js'
import { handler as rememberHandler } from './remember.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const LLM_MODEL = process.env.LLM_MODEL_NAME ?? 'gpt-4o-mini'

export const schema = z.object({
  task_summary: z.string().min(1).describe('Summary of the completed task'),
  decisions_made: z.array(z.string()).optional().describe('Explicit decisions made during the task'),
  patterns_used: z.array(z.string()).optional().describe('Patterns applied during the task'),
  author: z.string().optional().default('claude').describe('Authoring agent (default: claude)'),
  session_id: z.string().optional(),
})

/**
 * @typedef {{ topic: string, key: string, content: string, entity_type: string, confidence: number, mode: string }} ExtractedItem
 */

/**
 * Extract learnable knowledge from a task summary using LLM.
 * @param {string} taskSummary
 * @param {string[]} [decisionsMade]
 * @param {string[]} [patternsUsed]
 * @returns {Promise<ExtractedItem[]>}
 */
async function extractKnowledge(taskSummary, decisionsMade = [], patternsUsed = []) {
  if (!OPENAI_API_KEY) {
    return []
  }

  const systemPrompt = `You are a conservative knowledge extractor for an engineering knowledge graph. You extract reusable, team-specific engineering knowledge from a completed task summary.

RULES:
- Base your extraction ONLY on the text provided. Do not infer unstated context, invent technical facts, or draw on information outside this prompt.
- Over-extraction is worse than under-extraction. If in doubt, do not extract. Returning zero items is a valid and often correct answer.
- Quality test: ask "If a senior engineer asked 'why did we do X?', would this entry be the answer?" If no, do not extract it.
- Do NOT extract: generic programming concepts, language/framework basics, implementation details of a single function, debugging steps, temporary workarounds you intend to revert, obvious conclusions (e.g. "we used a for-loop"), restatements of the task itself.
- Do NOT extract secrets, credentials, API keys, tokens, passwords, personally identifiable information (PII), or security-sensitive configuration values. If a value of this kind appears in the task summary, omit the corresponding item entirely.
- Extract a maximum of 3 items. Fewer is better when content is thin.

OUTPUT SCHEMA (return exactly this shape, no extra fields):
{
  "items": [
    {
      "topic": string,           // one of: auth | api | db | infra | testing | security | payments — or another short domain word if none of these fit
      "key": string,             // kebab-case, specific enough to be unique (e.g. "jwt-refresh-on-expiry", NOT "auth-approach")
      "content": string,         // the knowledge in 1-3 sentences
      "entity_type": string,     // one of: Decision | Pattern | Constraint | Runbook | Requirement
      "confidence": number,      // 0.35 (generalising from one case) | 0.55 (extracting a pattern) | 0.75 (echoing an explicit decision)
      "mode": string             // one of: "echoing" | "extracting" | "generalising" — must align with confidence
    }
  ]
}

CONSTRAINTS:
- Return a JSON OBJECT with an "items" array. Do not return a bare array.
- items length: 0 to 3 inclusive. Empty array {"items": []} is correct when nothing meets the quality bar.
- mode must match confidence: 0.75 → "echoing", 0.55 → "extracting", 0.35 → "generalising".
- Do not add extra fields at any level.
- Do not explain your reasoning outside the JSON.
- Reply with only valid JSON.`

  const userPrompt = `Task summary:
"${taskSummary}"
${decisionsMade.length ? `\nExplicit decisions made:\n- ${decisionsMade.join('\n- ')}` : ''}
${patternsUsed.length ? `\nPatterns used:\n- ${patternsUsed.join('\n- ')}` : ''}

Extract reusable engineering knowledge per the rules. Return the JSON object as specified.`

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) return []

  try {
    const data = await response.json()
    const text = data.choices?.[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(text)
    return parsed.items ?? []
  } catch {
    return []
  }
}

/**
 * Check if an identical DRAFT for this topic:key already exists in knowledge_versions.
 * Prevents reflect() from inserting the same content twice on repeated task summaries.
 *
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} contentHash - SHA-256 hex of the content body
 * @returns {Promise<boolean>}
 */
async function isDuplicateReflect(pg, topic, key, contentHash) {
  const { rows } = await pg.query(
    `SELECT id FROM knowledge_versions
     WHERE topic = $1 AND key = $2 AND status = 'DRAFT' AND content_hash = $3
     LIMIT 1`,
    [topic, key, contentHash],
  )
  return rows.length > 0
}

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input) {
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'reflect',
      author: input.author ?? 'claude',
      sessionId: input.session_id,
      governanceData: { task_summary_length: input.task_summary.length },
    },
    async () => {
      const extracted = await extractKnowledge(
        input.task_summary,
        input.decisions_made,
        input.patterns_used,
      )

      const stored = []
      const conflicts = []
      const failed = []
      let skipped = 0

      for (const item of extracted) {
        // GAP-13: skip if identical content already exists as DRAFT for this topic:key
        const contentHash = createHash('sha256').update(item.content).digest('hex')
        // eslint-disable-next-line no-await-in-loop
        if (await isDuplicateReflect(pg, item.topic, item.key, contentHash)) {
          skipped++
          continue
        }

        try {
          const result = await rememberHandler(pg, {
            topic: item.topic,
            key: item.key,
            content: item.content,
            author: input.author ?? 'claude',
            confidence: item.confidence,
            entity_type: item.entity_type,
            triggered_by: TriggeredBy.REFLECT,
            session_id: input.session_id,
          })

          if (result?.status === 'conflict_detected') {
            conflicts.push({ ...item, conflict: result })
          } else {
            stored.push({ ...item, result })
          }
        } catch (err) {
          failed.push({ ...item, error: err.message })
        }
      }

      return {
        result: {
          extracted: extracted.length,
          stored: stored.length,
          conflicts: conflicts.length,
          failed: failed.length,
          skipped,
          items: stored,
          conflict_items: conflicts,
          failed_items: failed,
          note: extracted.length === 0
            ? 'No team-specific knowledge identified in this task.'
            : skipped === extracted.length
              ? `All ${extracted.length} item(s) already in DRAFT — no duplicates stored.`
              : `${stored.length} knowledge item(s) added as DRAFT — pending review.${skipped > 0 ? ` ${skipped} skipped (duplicate).` : ''}`,
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
