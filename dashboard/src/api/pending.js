import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function usePending() {
  return useQuery({
    queryKey: ['pending'],
    queryFn:  () => apiFetch('/pg/pending'),
    refetchInterval: 60_000,
  })
}

export function useDrafts() {
  return useQuery({
    queryKey: ['pending-drafts'],
    queryFn:  () => apiFetch('/api/drafts'),
    refetchInterval: 60_000,
  })
}

export function useReview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ conflictId, action, note }) =>
      apiFetch(`/api/review/${encodeURIComponent(conflictId)}`, {
        method: 'POST',
        body:   JSON.stringify({ action, note }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

/**
 * Mutation to approve or reject a pending deprecation request.
 * Invalidates pending, knowledge, and stats queries on success.
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useReviewDeprecationRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ requestId, action, note }) =>
      apiFetch(`/api/review/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        body:   JSON.stringify({ action, note }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending'] })
      qc.invalidateQueries({ queryKey: ['knowledge'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

export function usePromoteDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ topic, key, note }) =>
      apiFetch(`/api/knowledge/${encodeURIComponent(topic)}/${encodeURIComponent(key)}/promote`, {
        method: 'POST',
        body:   JSON.stringify({ note }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-drafts'] })
      qc.invalidateQueries({ queryKey: ['knowledge'] })
      qc.invalidateQueries({ queryKey: ['knowledge-detail'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
