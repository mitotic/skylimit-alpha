/**
 * AcceleratedClock - Displays current accelerated time when connected to Skyspeed
 *
 * Displayed when connected to a Skyspeed test server with clockFactor > 1.
 * Shows month/date, time in HH:MM 24-hour format, and clock factor label (e.g., "60x").
 */

import { useState, useEffect } from 'react'
import { clientDate, isClockAccelerated, getClockFactor } from '../utils/clientClock'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function AcceleratedClock() {
  const [accelerated, setAccelerated] = useState(isClockAccelerated())
  const [dateLabel, setDateLabel] = useState('')
  const [clockVersion, setClockVersion] = useState(0)
  const [timeText, setTimeText] = useState('')

  // Listen for clock configuration changes (fired by configureClientClock/resetClientClock)
  useEffect(() => {
    function handleClockChange() {
      setAccelerated(isClockAccelerated())
      setClockVersion(v => v + 1)
    }
    window.addEventListener('clientClockChange', handleClockChange)
    return () => window.removeEventListener('clientClockChange', handleClockChange)
  }, [])

  // Update text time display when accelerated
  useEffect(() => {
    if (!accelerated) return

    const factor = getClockFactor()

    function update() {
      const now = clientDate()
      setDateLabel(`${MONTHS[now.getMonth()]} ${now.getDate()}`)
      const hh = now.getHours().toString().padStart(2, '0')
      const mm = now.getMinutes().toString().padStart(2, '0')
      setTimeText(`${hh}:${mm}`)
    }

    update()

    // Update every accelerated minute or every real second, whichever is longer
    const intervalMs = Math.max(60000 / factor, 1000)
    const id = setInterval(update, intervalMs)
    return () => clearInterval(id)
  }, [accelerated, clockVersion])

  if (!accelerated) return null

  const factor = getClockFactor()

  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-orange-500 dark:text-orange-400 text-xs font-bold">{dateLabel}</span>
      <span className="text-orange-500 dark:text-orange-400 text-xs font-bold">{timeText}</span>
      <span className="text-orange-500 dark:text-orange-400 text-xs font-bold">{factor}x</span>
    </span>
  )
}
