/**
 * Deviations API client — Wave C+D
 *
 * Hooks:
 *   useDeviations(filters)   — list deviations with optional filters
 *   useDeviationAction()     — mutation to accept / deny / defer a deviation
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'

/**
 * List deviations for the current project with optional filters.
 *
 * @param {{
 *   status?:       string,
 *   catalog_id?:   string,
 *   topic?:        string,
 *   severity_min?: number,
 *   source?:       string,
 *   limit?:        number,
 *   offset?:       number,
 * }} [filters]
 */
export function useDeviations(filters = {}) {
  const params = new URLSearchParams()
  if (filters.status)       params.set('status',       filters.status)
  if (filters.catalog_id)   params.set('catalog_id',   filters.catalog_id)
  if (filters.topic)        params.set('topic',         filters.topic)
  if (filters.severity_min !== undefined) params.set('severity_min', String(filters.severity_min))
  if (filters.source)       params.set('source',        filters.source)
  if (filters.limit)        params.set('limit',          String(filters.limit))
  if (filters.offset)       params.set('offset',         String(filters.offset))

  const qs = params.toString()
  return useQuery({
    queryKey:  ['deviations', filters],
    queryFn:   () => apiFetch(`/api/deviations${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  })
}

/**
 * Mutation to action a deviation (accept / deny / defer).
 *
 * Usage:
 *   const action = useDeviationAction()
 *   await action.mutateAsync({ id, action_type: 'accept', reason: '...' })
 *   await action.mutateAsync({ id, action_type: 'defer',  reason: '...', defer_until: isoString })
 */
export function useDeviationAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action_type, reason, defer_until }) =>
      apiFetch(`/api/deviations/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body:   JSON.stringify({ action_type, reason, defer_until }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deviations'] })
    },
  })
}
