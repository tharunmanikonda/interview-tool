import { error as logError } from '@tauri-apps/plugin-log'
import { RotateCcw } from 'lucide-react'
import { Switch } from '../ui/switch'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { useIsAutostartEnabled, useToggleAutostart } from '@/hooks/useAutostart'
import { useRestartOnboarding } from '@/hooks/useOnboardingNavigation'

export function System() {
  const { data: isEnabled, isLoading: isCheckingStatus } = useIsAutostartEnabled()
  const { toggle, isLoading: isToggling } = useToggleAutostart()
  const restartOnboarding = useRestartOnboarding()

  const handleToggleAutostart = async (checked: boolean) => {
    try {
      await toggle(!checked) // Toggle to the opposite of current state
    } catch (e) {
      logError(`[System] Failed to toggle autostart: ${e}`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">System Settings</p>
        <p className="text-sm">Configure how Dictara integrates with your system.</p>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label htmlFor="autostart" className="text-base">
            Launch at Startup
          </Label>
          <p className="text-sm text-muted-foreground">
            Automatically start Dictara when you log in to your computer
          </p>
        </div>
        <Switch
          id="autostart"
          checked={isEnabled ?? false}
          onCheckedChange={handleToggleAutostart}
          disabled={isCheckingStatus || isToggling}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label className="text-base">Restart Onboarding</Label>
          <p className="text-sm text-muted-foreground">
            Go through the initial setup wizard again. This can help troubleshoot configuration
            issues or reset your preferences
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => restartOnboarding.mutate()}
          disabled={restartOnboarding.isPending}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {restartOnboarding.isPending ? 'Restarting...' : 'Restart'}
        </Button>
      </div>
    </div>
  )
}
