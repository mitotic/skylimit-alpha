/**
 * AcceleratedClock - SVG analog clock showing current accelerated time
 *
 * Displayed when connected to a Skyspeed test server with clockFactor > 1.
 * Shows a small analog clock face with hour tick marks and an hour hand,
 * plus the clock factor label (e.g., "60x").
 */

import { useState, useEffect } from 'react'
import { clientDate, clientInterval, clearClientInterval, getClockFactor, isClockAccelerated } from '../utils/clientClock'

const CLOCK_SIZE = 24
const CENTER = CLOCK_SIZE / 2
const RADIUS = 10
const TICK_OUTER = RADIUS
const TICK_INNER = RADIUS - 2.5
const HAND_LENGTH = 7

export default function AcceleratedClock() {
  const [accelerated, setAccelerated] = useState(isClockAccelerated())
  const [hourAngle, setHourAngle] = useState(0)

  // Listen for clock configuration changes (fired by configureClientClock/resetClientClock)
  useEffect(() => {
    function handleClockChange() {
      setAccelerated(isClockAccelerated())
    }
    window.addEventListener('clientClockChange', handleClockChange)
    return () => window.removeEventListener('clientClockChange', handleClockChange)
  }, [])

  // Update hour hand angle when accelerated
  useEffect(() => {
    if (!accelerated) return

    function updateAngle() {
      const now = clientDate()
      const hours = now.getHours() % 12
      const minutes = now.getMinutes()
      setHourAngle((hours + minutes / 60) * 30)
    }

    updateAngle()

    // Update every accelerated hour (at 60x, this is every real minute)
    const interval = clientInterval(updateAngle, 60 * 60 * 1000)
    return () => clearClientInterval(interval)
  }, [accelerated])

  if (!accelerated) return null

  const factor = getClockFactor()

  // Generate 12 tick marks
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const angle = (i * 30 - 90) * (Math.PI / 180)
    return {
      x1: CENTER + TICK_OUTER * Math.cos(angle),
      y1: CENTER + TICK_OUTER * Math.sin(angle),
      x2: CENTER + TICK_INNER * Math.cos(angle),
      y2: CENTER + TICK_INNER * Math.sin(angle),
    }
  })

  // Hour hand endpoint
  const handAngleRad = (hourAngle - 90) * (Math.PI / 180)
  const handX = CENTER + HAND_LENGTH * Math.cos(handAngleRad)
  const handY = CENTER + HAND_LENGTH * Math.sin(handAngleRad)

  return (
    <span className="inline-flex items-center gap-1">
      <svg
        width={CLOCK_SIZE}
        height={CLOCK_SIZE}
        viewBox={`0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}`}
        className="inline-block"
      >
        {/* Clock face */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="text-gray-400 dark:text-gray-500"
        />

        {/* Hour tick marks */}
        {ticks.map((tick, i) => (
          <line
            key={i}
            x1={tick.x1}
            y1={tick.y1}
            x2={tick.x2}
            y2={tick.y2}
            stroke="currentColor"
            strokeWidth={i % 3 === 0 ? '1.5' : '0.75'}
            className="text-gray-400 dark:text-gray-500"
          />
        ))}

        {/* Hour hand */}
        <line
          x1={CENTER}
          y1={CENTER}
          x2={handX}
          y2={handY}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="text-orange-500 dark:text-orange-400"
        />

        {/* Center dot */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r="1"
          fill="currentColor"
          className="text-orange-500 dark:text-orange-400"
        />
      </svg>
      <span className="text-orange-500 dark:text-orange-400 text-xs font-bold">{factor}x</span>
    </span>
  )
}
