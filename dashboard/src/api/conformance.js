/**
 * Conformance API client — Wave E
 *
 * Hooks:
 *   useConformance()   — project conformance scorecard (score, status, breakdown, catalogs)
 *   usePortfolio(opts) — portfolio view for executive/admin users
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

/**
 * Project conformance scorecard.
 * Returns UNCERTIFIED when catalog coverage is too sparse or no scan has run yet.
 *
 * @returns {import('@tanstack/react-query').UseQueryResult<{
 *   score:             number | null,
 *   status:            'CERTIFIED' | 'UNCERTIFIED',
 *   applicable_entries: number,
 *   scan_count:        number,
 *   last_scan_at:      string | null,
 *   breakdown:         { open: number, accepted: number, denied: number, deferred: number, overdue: number, resolved: number },
 *   catalogs:          Array<{ catalog_id: string, entry_count: number }>,
 * }>}
 */
export function useConformance() {
  return useQuery({
    queryKey:  ['conformance'],
    queryFn:   () => apiFetch('/api/conformance'),
    staleTime: 60_000,
  })
}

/**
 * Portfolio conformance view — all accessible projects with their scores.
 * Auth-gated on the gateway; returns 403 for non-executive roles.
 *
 * @param {{ node_id?: string }} [opts]
 * @returns {import('@tanstack/react-query').UseQueryResult<{
 *   projects: Array<object>,
 *   rollup:   { score: number|null, status: string, certified_count: number, uncertified_count: number } | null,
 * }>}
 */
export function usePortfolio(opts = {}) {
  const params = new URLSearchParams()
  if (opts.node_id) params.set('node_id', opts.node_id)
  const qs = params.toString()

  return useQuery({
    queryKey:  ['portfolio', opts],
    queryFn:   () => apiFetch(`/api/portfolio${qs ? `?${qs}` : ''}`),
    staleTime: 120_000,
    retry:     false,   // don't retry 403 — not a transient error
  })
}
