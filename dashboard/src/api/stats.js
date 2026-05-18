import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client.js'

export const STATS_KEY = ['stats']

/** Fetch aggregated dashboard metrics. Polled every 60 s for notification badge. */
export function useStats(options = {}) {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn:  () => apiFetch('/api/stats'),
    refetchInterval: 60_000,
    ...options,
  })
}
