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
 * Deprecate a single ACTIVE knowledge entry (principal_architect only).
 * @param {string} topic
 * @param {string} key
 * @param {string} reason - Required, min 10 chars
 */
export function deprecateKnowledge(topic, key, reason) {
  return apiFetch(
    `/api/knowledge/${encodeURIComponent(topic)}/${encodeURIComponent(key)}/deprecate`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  )
}

/**
 * Deprecate multiple ACTIVE knowledge entries in a single request.
 * @param {Array<{topic: string, key: string}>} entries
 * @param {string} reason - Shared reason for all entries
 */
export function deprecateKnowledgeBulk(entries, reason) {
  return apiFetch('/api/knowledge/deprecate/bulk', {
    method: 'POST',
    body:   JSON.stringify({ entries, reason }),
  })
}

/**
 * Endorse an ACTIVE knowledge entry (bump its confidence).
 * @param {string} topic
 * @param {string} key
 */
export function bumpKnowledge(topic, key) {
  return apiFetch(
    `/api/bump/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}

/**
 * TanStack Query mutation hook that invalidates knowledge + stats caches on success.
 * @param {(data: unknown) => void} onSuccess
 */
export function useKnowledgeWrite(onSuccess) {
  const queryClient = useQueryClient()
  return {
    create:        useMutation({ mutationFn: createKnowledge,   onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    promote:       useMutation({ mutationFn: ({ topic, key, note }) => promoteKnowledge(topic, key, note), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    supersede:     useMutation({ mutationFn: ({ topic, key, ...fields }) => supersedeKnowledge(topic, key, fields), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    deprecate:     useMutation({ mutationFn: ({ topic, key, reason }) => deprecateKnowledge(topic, key, reason), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    deprecateBulk: useMutation({ mutationFn: ({ entries, reason }) => deprecateKnowledgeBulk(entries, reason), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
    bump:          useMutation({ mutationFn: ({ topic, key }) => bumpKnowledge(topic, key), onSuccess: (d) => { invalidate(queryClient); onSuccess?.(d) } }),
  }
}

function invalidate(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['knowledge'] })
  queryClient.invalidateQueries({ queryKey: ['knowledge-detail'] })
  queryClient.invalidateQueries({ queryKey: ['stats'] })
}
