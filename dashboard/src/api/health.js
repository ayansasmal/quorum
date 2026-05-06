import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn:  () => apiFetch('/health'),
    refetchInterval: 30_000,
  })
}
