import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/bindings'

/**
 * Hook to check if autostart is enabled
 */
export function useIsAutostartEnabled() {
  return useQuery({
    queryKey: ['autostart', 'isEnabled'],
    queryFn: async (): Promise<boolean> => {
      const result = await commands.isAutostartEnabled()
      if (result.status === 'error') {
        throw new Error(result.error)
      }
      return result.data
    },
  })
}

/**
 * Hook to enable autostart
 */
export function useEnableAutostart() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const result = await commands.enableAutostart()
      if (result.status === 'error') {
        throw new Error(result.error)
      }
    },
    onSuccess: () => {
      // Invalidate the autostart query to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ['autostart', 'isEnabled'] })
    },
  })
}

/**
 * Hook to disable autostart
 */
export function useDisableAutostart() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const result = await commands.disableAutostart()
      if (result.status === 'error') {
        throw new Error(result.error)
      }
    },
    onSuccess: () => {
      // Invalidate the autostart query to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ['autostart', 'isEnabled'] })
    },
  })
}

/**
 * Hook to toggle autostart (enable/disable based on current state)
 */
export function useToggleAutostart() {
  const enableMutation = useEnableAutostart()
  const disableMutation = useDisableAutostart()

  return {
    toggle: async (isEnabled: boolean) => {
      if (isEnabled) {
        await disableMutation.mutateAsync()
      } else {
        await enableMutation.mutateAsync()
      }
    },
    isLoading: enableMutation.isPending || disableMutation.isPending,
  }
}
