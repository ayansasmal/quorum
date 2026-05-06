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

/** Entity type → Tailwind colour. Matches tailwind.config.js custom colours. */
export const ENTITY_COLORS = {
  Decision:    'text-blue-400    bg-blue-900/30   border-blue-700',
  Pattern:     'text-green-400   bg-green-900/30  border-green-700',
  Constraint:  'text-amber-400   bg-amber-900/30  border-amber-700',
  Runbook:     'text-purple-400  bg-purple-900/30 border-purple-700',
  Requirement: 'text-gray-400    bg-gray-800/50   border-gray-600',
  unknown:     'text-gray-500    bg-gray-800/30   border-gray-700',
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
