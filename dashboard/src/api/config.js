import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'
import { useAuth } from '../context/AuthContext.jsx'

export function useConfig() {
  const { user } = useAuth()
  const projectId = user?.project
  return useQuery({
    queryKey:  ['config', projectId],
    queryFn:   () => apiFetch(`/config/${encodeURIComponent(projectId)}`),
    enabled:   !!projectId,
    staleTime: 60_000,
  })
}

export function useValidateConfig() {
  return useMutation({
    mutationFn: (config) => apiFetch('/config/validate', {
      method: 'POST',
      body:   JSON.stringify(config),
    }),
  })
}

export function useSaveConfig() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (config) => apiFetch(`/config/${encodeURIComponent(user?.project)}`, {
      method: 'PUT',
      body:   JSON.stringify(config),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  })
}
