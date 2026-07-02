import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/bindings'

export type MicrophonePermissionStatus = 'authorized' | 'denied' | 'restricted' | 'not_determined'

/**
 * Hook to check microphone permission status.
 * Polls every 1 second to detect permission changes in System Settings.
 */
export function useMicrophonePermission() {
  return useQuery({
    queryKey: ['microphonePermission'],
    queryFn: async (): Promise<MicrophonePermissionStatus> => {
      return (await commands.checkMicrophonePermission()) as MicrophonePermissionStatus
    },
    refetchInterval: 1000,
  })
}

/**
 * Hook to request microphone permission (triggers native permission dialog).
 */
export function useRequestMicrophonePermission() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<boolean> => {
      return await commands.requestMicrophonePermission()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microphonePermission'] })
    },
  })
}

/**
 * Hook to open System Settings to the Microphone pane.
 */
export function useOpenMicrophoneSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<void> => {
      await commands.openMicrophoneSettings()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microphonePermission'] })
    },
  })
}
