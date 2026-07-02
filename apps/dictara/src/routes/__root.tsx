import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useSystemTheme } from '@/hooks/useSystemTheme'

function RootLayout() {
  useSystemTheme()
  return <Outlet />
}

export const Route = createRootRoute({
  component: RootLayout,
})
