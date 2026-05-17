/**
 * Governance API clients — ownership transfer, role updates, admin management.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client.js'
import { useAuth } from '../context/AuthContext.jsx'

export function useUserProfile(username) {
  return useQuery({
    queryKey:  ['profile', username],
    queryFn:   () => apiFetch(`/user/profile/${encodeURIComponent(username)}`),
    enabled:   !!username,
    staleTime: 60_000,
  })
}

export function useTransferOwnership() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ to, reason }) => apiFetch('/config/transfer-ownership', {
      method: 'POST',
      body:   JSON.stringify({ to, reason }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      qc.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useUpdateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ github_username, role, reason }) => apiFetch('/config/update-role', {
      method: 'POST',
      body:   JSON.stringify({ github_username, role, reason }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      qc.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useAdminConfig() {
  return useQuery({
    queryKey: ['admin', 'config'],
    queryFn:  () => apiFetch('/admin/config'),
    staleTime: 60_000,
  })
}

export function useAdminUsers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, github_username, reason }) => apiFetch('/admin/users', {
      method: 'POST',
      body:   JSON.stringify({ action, github_username, reason }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}
