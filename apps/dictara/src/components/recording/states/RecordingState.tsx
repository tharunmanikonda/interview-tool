interface RecordingStateProps {
  elapsedMs: number
  smoothedLevel: number
  onCancel: () => void
  onStop: () => void
  isCancelPending: boolean
  isStopPending: boolean
}

// Calculate inset shadow based on audio level
// Creates a white glow from the edges inward when speaking
function getInsetShadow(level: number): string {
  const spreadSize = Math.round(level * 60) // 0-60px spread
  const opacity = level * 0.3 // 0-0.3 opacity for subtle effect
  return `inset 0 0 ${spreadSize}px rgba(255, 255, 255, ${opacity})`
}

// Format milliseconds to MM:SS
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function RecordingState({
  elapsedMs,
  smoothedLevel,
}: RecordingStateProps) {
  return (
    <div
      className="dictara-recording-signal"
      style={{ boxShadow: getInsetShadow(smoothedLevel) }}
      aria-label="Dictara recording"
    >
      <div className="dictara-recording-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="dictara-recording-copy">
        <strong>Dictara</strong>
        <span>{formatTime(elapsedMs)}</span>
      </div>
    </div>
  )
}
