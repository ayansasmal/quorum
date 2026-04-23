import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function useBump() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ topic, key }) =>
      apiFetch(`/api/bump/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['knowledge'] })
    },
  })
}
