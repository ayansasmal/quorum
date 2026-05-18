import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/**
 * Create a new ACTIVE knowledge entry (principal_architect only).
 * @param {{ topic, key, content, entity_type, tags?, confidence? }} fields
 */
export function createKnowledge(fields) {
  return apiFetch('/api/knowledge', {
    method: 'POST',
    body:   JSON.stringify(fields),
  })
}

/**
 * Promote a DRAFT knowledge entry to ACTIVE (principal_architect only).
 * @param {string} topic
 * @param {string} key
 * @param {string} note - Required reason (min 10 chars)
 */
export function promoteKnowledge(topic, key, note) {
  return apiFetch(`/api/knowledge/${topic}/${key}/promote`, {
    method: 'POST',
    body:   JSON.stringify({ note }),
  })
}

/**
 * Supersede an ACTIVE knowledge entry with a new version (principal_architect only).
 * @param {string} topic
 * @param {string} key
 * @param {{ content, entity_type, tags?, confidence?, reason }} fields
 */
export function supersedeKnowledge(topic, key, fields) {
  return apiFetch(`/api/knowledge/${topic}/${key}/supersede`, {
    method: 'POST',
    body:   JSON.stringify(fields),
  })
}

/**
 * TanStack Query mutation hook that invalidates knowledge + stats caches on success.
 * @param {(data: unknown) => void} onSuccess
 */
export function useKnowledgeWrite(onSuccess) {
  const queryClient = useQueryClient()
  return {
    create:   useMutation({ mutationFn: createKnowledge,   onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    promote:  useMutation({ mutationFn: ({ topic, key, note }) => promoteKnowledge(topic, key, note), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    supersede: useMutation({ mutationFn: ({ topic, key, ...fields }) => supersedeKnowledge(topic, key, fields), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
  }
}

function invalidate(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['knowledge'] })
  queryClient.invalidateQueries({ queryKey: ['knowledge-detail'] })
  queryClient.invalidateQueries({ queryKey: ['stats'] })
}
