/**
 * Prompt loader — reads prompt markdown files and returns { system, user } sections.
 *
 * File format:
 *   ## System
 *
 *   <system prompt text>
 *
 *   ## User
 *
 *   <user prompt template with {{variable}} placeholders>
 *
 * Substitutes {{variable}} placeholders with values from the provided `vars` object.
 * Files are read once and cached in-process per filename.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url))

/** @type {Map<string, { system: string, user: string }>} */
const cache = new Map()

/**
 * Read and parse a prompt markdown file. Caches parsed sections per filename.
 * @param {string} filename
 * @returns {{ system: string, user: string }}
 */
function readAndParse(filename) {
  if (cache.has(filename)) return cache.get(filename)
  const raw = readFileSync(join(PROMPTS_DIR, filename), 'utf8')
  // Normalize so a leading "## System\n" matches the same pattern as "\n## System\n".
  const normalized = raw.startsWith('## System') ? `\n${raw}` : raw
  const [, afterSystem] = normalized.split('\n## System\n')
  if (afterSystem === undefined) {
    throw new Error(`Prompt file ${filename} missing "## System" header`)
  }
  const [system, user] = afterSystem.split('\n## User\n')
  if (user === undefined) {
    throw new Error(`Prompt file ${filename} missing "## User" header`)
  }
  const parsed = { system: system.trim(), user: user.trim() }
  cache.set(filename, parsed)
  return parsed
}

/**
 * Substitute {{variable}} placeholders in a template with values from vars.
 * Missing variables are left in place as {{variable}} for easier debugging.
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function substitute(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

/**
 * Load and render a prompt file with variable substitution.
 * @param {string} filename - filename relative to src/prompts/
 * @param {Record<string, string>} [vars] - placeholder substitutions
 * @returns {{ system: string, user: string }}
 */
export function loadPrompt(filename, vars = {}) {
  const { system, user } = readAndParse(filename)
  return {
    system: substitute(system, vars),
    user: substitute(user, vars),
  }
}
