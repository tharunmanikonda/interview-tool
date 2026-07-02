import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

const THEME_ENABLED_WINDOWS = ['onboarding', 'preferences']

export function useSystemTheme() {
  useEffect(() => {
    const setupTheme = async () => {
      // Get current window label
      const currentWindow = getCurrentWindow()
      const windowLabel = currentWindow.label

      // Check if this window should have theme support
      const isThemeEnabled = THEME_ENABLED_WINDOWS.includes(windowLabel)

      // If this window shouldn't have theme support (e.g., recording-popup),
      // remove the dark class that might have been applied by the inline script
      if (!isThemeEnabled) {
        document.documentElement.classList.remove('dark')
        return
      }

      // For theme-enabled windows, the inline script in index.html already
      // applied the initial theme, so we just need to listen for changes
      const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)')

      const applyDarkMode = (isDark: boolean) => {
        if (isDark) {
          document.documentElement.classList.add('dark')
        } else {
          document.documentElement.classList.remove('dark')
        }
      }

      // Listen for system theme changes
      const handleChange = (e: MediaQueryListEvent) => {
        applyDarkMode(e.matches)
      }

      darkModeQuery.addEventListener('change', handleChange)

      // Cleanup
      return () => {
        darkModeQuery.removeEventListener('change', handleChange)
      }
    }

    setupTheme()
  }, [])
}
