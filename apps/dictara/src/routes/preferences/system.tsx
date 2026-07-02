import { createFileRoute } from '@tanstack/react-router'
import { System } from '@/components/preferences/System'

export const Route = createFileRoute('/preferences/system')({
  component: SystemRoute,
})

function SystemRoute() {
  return <System />
}
