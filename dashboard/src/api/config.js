import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'
import { useAuth } from '../context/AuthContext.jsx'

export function useConfig() {
  // Use selectedProject (sessionStorage-backed) rather than user?.project (JWT-derived)
  // so the query stays enabled on refresh even if the stored user object is stale.
  const { selectedProject } = useAuth()
  return useQuery({
    queryKey:  ['config', selectedProject],
    queryFn:   () => apiFetch(`/config/${encodeURIComponent(selectedProject)}`),
    enabled:   !!selectedProject,
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
  const { selectedProject } = useAuth()
  return useMutation({
    mutationFn: (config) => apiFetch(`/config/${encodeURIComponent(selectedProject)}`, {
      method: 'PUT',
      body:   JSON.stringify(config),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  })
}
