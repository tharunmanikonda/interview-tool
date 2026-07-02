import { StepContainer } from '../StepContainer'
import { useOnboardingNavigation } from '@/hooks/useOnboardingNavigation'
import {
  useMicrophonePermission,
  useRequestMicrophonePermission,
  useOpenMicrophoneSettings,
} from '@/hooks/useMicrophonePermission'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CheckCircle2, AlertCircle, Mic, Settings } from 'lucide-react'

export function MicrophoneStep() {
  const { data: permissionStatus, isLoading: isChecking } = useMicrophonePermission()
  const requestPermission = useRequestMicrophonePermission()
  const openSettings = useOpenMicrophoneSettings()
  const { goNext, goBack, skipOnboarding, isNavigating } = useOnboardingNavigation()

  const isAuthorized = permissionStatus === 'authorized'
  const isDenied = permissionStatus === 'denied' || permissionStatus === 'restricted'

  const handleNext = () => {
    if (isAuthorized) {
      goNext('microphone')
    }
  }

  if (permissionStatus === undefined || isChecking) {
    return (
      <StepContainer
        title="Microphone Permission"
        description="Checking permission status..."
        showBack={true}
        showSkip={true}
        onBack={() => goBack('microphone')}
        onSkip={() => skipOnboarding.mutate()}
      >
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">Checking...</p>
        </div>
      </StepContainer>
    )
  }

  // Permission granted - show success state
  if (isAuthorized) {
    return (
      <StepContainer
        title="Microphone Permission"
        description="Permission granted!"
        onNext={handleNext}
        onBack={() => goBack('microphone')}
        onSkip={() => skipOnboarding.mutate()}
        isLoading={isNavigating || skipOnboarding.isPending}
      >
        <div className="space-y-6">
          <div className="flex justify-center py-4">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
              <Mic className="w-8 h-8 text-green-500" />
            </div>
          </div>

          <Alert className="border-green-500/50 bg-green-500/10">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <AlertDescription className="text-green-700 dark:text-green-400">
              Dictara can access your microphone for voice recording.
            </AlertDescription>
          </Alert>

          <p className="text-sm text-muted-foreground text-center">
            You're all set! Click Next to continue.
          </p>
        </div>
      </StepContainer>
    )
  }

  // Permission denied - show instructions to enable in System Settings
  if (isDenied) {
    return (
      <StepContainer
        title="Microphone Permission"
        description="Dictara needs microphone access to record your voice."
        onNext={handleNext}
        nextDisabled={true}
        onBack={() => goBack('microphone')}
        onSkip={() => skipOnboarding.mutate()}
        isLoading={isNavigating || skipOnboarding.isPending}
      >
        <div className="space-y-6">
          <div className="flex justify-center py-4">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <Mic className="w-8 h-8 text-destructive" />
            </div>
          </div>

          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Microphone permission is not configured. Please enable it in System Settings.
            </AlertDescription>
          </Alert>

          <div className="flex items-start gap-3 p-4 bg-muted/50 rounded-lg">
            <Settings className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="text-sm font-medium">Enable Microphone Access</p>
              <p className="text-sm text-muted-foreground">
                Open System Settings, go to Privacy & Security → Microphone, and toggle ON for
                Dictara.
              </p>
              <Button variant="default" onClick={() => openSettings.mutate()}>
                Open System Settings
              </Button>
            </div>
          </div>
        </div>
      </StepContainer>
    )
  }

  // Permission not determined - show button to request permission (triggers native dialog)
  return (
    <StepContainer
      title="Microphone Permission"
      description="Dictara needs microphone access to record your voice."
      onNext={handleNext}
      nextDisabled={!isAuthorized}
      onBack={() => goBack('microphone')}
      onSkip={() => skipOnboarding.mutate()}
      isLoading={isNavigating || skipOnboarding.isPending || requestPermission.isPending}
    >
      <div className="space-y-6">
        <div className="flex justify-center py-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Mic className="w-8 h-8 text-primary" />
          </div>
        </div>

        <p className="text-sm text-muted-foreground text-center">
          When you press the trigger key, Dictara will record audio from your microphone and convert
          it to text. This requires microphone permission.
        </p>

        <div className="flex items-start gap-3 p-4 bg-muted/50 rounded-lg">
          <Mic className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="space-y-2">
            <p className="text-sm font-medium">Grant Microphone Access</p>
            <p className="text-sm text-muted-foreground">
              Click the button below to grant microphone access. A system dialog will appear asking
              for your permission.
            </p>
            <Button
              variant="default"
              onClick={() => requestPermission.mutate()}
              disabled={requestPermission.isPending}
            >
              {requestPermission.isPending ? 'Requesting...' : 'Request Permission'}
            </Button>
          </div>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            After granting the permission, this page will automatically update.
          </AlertDescription>
        </Alert>
      </div>
    </StepContainer>
  )
}
