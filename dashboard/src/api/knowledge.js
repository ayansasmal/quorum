import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function useKnowledge(filters = {}) {
  const { domain, tag, entity_type, page = 1, limit = 20 } = filters
  const params = new URLSearchParams({ page, limit })
  if (domain)      params.set('domain', domain)
  if (tag)         params.set('tag', tag)
  if (entity_type) params.set('entity_type', entity_type)

  return useQuery({
    queryKey: ['knowledge', filters],
    queryFn:  () => apiFetch(`/api/knowledge?${params}`),
    keepPreviousData: true,
  })
}

export function useSearch(query, domain) {
  const params = new URLSearchParams({ q: query, limit: '20' })
  if (domain) params.set('domain', domain)

  return useQuery({
    queryKey:  ['search', query, domain],
    queryFn:   () => apiFetch(`/api/search?${params}`),
    enabled:   Boolean(query && query.trim().length >= 2),
    staleTime: 30_000,
  })
}
