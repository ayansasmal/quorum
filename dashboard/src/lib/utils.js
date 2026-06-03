import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes safely, resolving conflicts. */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/** Decode a JWT payload (no signature verification — trust the server). */
export function decodeJwt(token) {
  try {
    const [, payload] = token.split('.')
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

/** Format a confidence score as a percentage string. */
export function fmtConfidence(value) {
  return `${Math.round((value ?? 0) * 100)}%`
}

/** Tailwind colour class for a confidence value. */
export function confidenceColor(value) {
  if (value >= 0.7) return 'text-green-400'
  if (value >= 0.4) return 'text-amber-400'
  return 'text-red-400'
}

/** Tailwind bg colour class for a confidence bar. */
export function confidenceBg(value) {
  if (value >= 0.7) return 'bg-green-500'
  if (value >= 0.4) return 'bg-amber-500'
  return 'bg-red-500'
}

/** Entity type → Tailwind colour. Light-mode-first + dark: overrides. */
export const ENTITY_COLORS = {
  Decision:    'text-blue-700   bg-blue-50    border-blue-300   dark:text-blue-400   dark:bg-blue-900/30   dark:border-blue-700',
  Pattern:     'text-green-700  bg-green-50   border-green-300  dark:text-green-400  dark:bg-green-900/30  dark:border-green-700',
  Constraint:  'text-amber-800  bg-amber-50   border-amber-300  dark:text-amber-400  dark:bg-amber-900/30  dark:border-amber-700',
  Runbook:     'text-purple-700 bg-purple-50  border-purple-300 dark:text-purple-400 dark:bg-purple-900/30 dark:border-purple-700',
  Requirement: 'text-teal-700   bg-teal-50    border-teal-300   dark:text-teal-400   dark:bg-teal-900/30   dark:border-teal-700',
  Standard:    'text-indigo-700 bg-indigo-50  border-indigo-300 dark:text-indigo-400 dark:bg-indigo-900/30 dark:border-indigo-700',
  Guideline:   'text-cyan-700   bg-cyan-50    border-cyan-300   dark:text-cyan-400   dark:bg-cyan-900/30   dark:border-cyan-700',
  unknown:     'text-gray-600   bg-gray-100   border-gray-300   dark:text-gray-500   dark:bg-gray-800/30   dark:border-gray-700',
}

/** Entity type badge colour. */
export function entityBadge(entityType) {
  return ENTITY_COLORS[entityType] ?? ENTITY_COLORS.unknown
}

/** Format ISO date string to a readable short form. */
export function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Format hours as "Xd Yh" or "Zh" depending on magnitude. */
export function fmtAge(hours) {
  if (hours == null) return '—'
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`
  return `${Math.round(hours)}h`
}
