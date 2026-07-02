import { createFileRoute } from '@tanstack/react-router'
import { MicrophoneStep } from '@/components/onboarding/steps/MicrophoneStep'

export const Route = createFileRoute('/onboarding/microphone')({
  component: MicrophoneStep,
})
