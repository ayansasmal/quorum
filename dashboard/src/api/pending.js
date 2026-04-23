import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function usePending() {
  return useQuery({
    queryKey: ['pending'],
    queryFn:  () => apiFetch('/pg/pending'),
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
