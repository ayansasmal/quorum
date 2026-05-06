import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function useAudit(filters = {}) {
  const params = new URLSearchParams({ limit: filters.limit ?? 50 })
  if (filters.author)    params.set('author', filters.author)
  if (filters.tool)      params.set('tool', filters.tool)
  if (filters.topic)     params.set('topic', filters.topic)

  return useQuery({
    queryKey: ['audit', filters],
    queryFn:  () => apiFetch(`/pg/audit?${params}`),
    staleTime: 30_000,
  })
}
