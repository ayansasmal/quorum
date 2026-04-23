import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function useGraph(domain) {
  return useQuery({
    queryKey: ['graph', domain],
    queryFn:  () => apiFetch(`/api/graph${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`),
    staleTime: 60_000,
  })
}
