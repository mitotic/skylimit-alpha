/**
 * Circular buffer that captures all console output for bug reports.
 *
 * Wraps console.log/warn/error/info/debug to copy every message into
 * an in-memory ring buffer. The originals are called first so normal
 * DevTools output is unaffected.
 *
 * Import this module as a side-effect early in app startup (main.tsx).
 */

const LOG_BUFFER_SIZE = 500

export interface LogEntry {
  timestamp: number
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  message: string
}

const buffer: LogEntry[] = []

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function pushEntry(level: LogEntry['level'], args: unknown[]) {
  const message = args.map(formatArg).join(' ')
  buffer.push({ timestamp: Date.now(), level, message })
  if (buffer.length > LOG_BUFFER_SIZE) {
    buffer.shift()
  }
}

// Map console method levels to the app's logger levels (0-4)
// error→0, warn→1, log/info→2, debug→3
// (verbose=4 uses console.log with a [Topic]-4 prefix, so it's captured as 'log')
const LEVEL_MAP: Record<LogEntry['level'], number> = {
  error: 0,
  warn: 1,
  log: 2,
  info: 2,
  debug: 3,
}

// Wrap each console method
const methods: LogEntry['level'][] = ['log', 'warn', 'error', 'info', 'debug']
for (const method of methods) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    original(...args)
    pushEntry(method, args)
  }
}

/** Return the last `n` entries from the buffer (all levels). */
export function getRecentLogs(n: number): LogEntry[] {
  if (n <= 0) return []
  return buffer.slice(-n)
}

/**
 * Return the last `n` entries whose app-level is ≤ `maxLevel`.
 *
 * Level mapping follows the app's logger convention:
 *   0 = errors only
 *   1 = + warnings
 *   2 = + milestones (log/info)
 *   3 = + debug
 *   4 = everything (same as 3 for buffer purposes; verbose uses console.log)
 */
export function getRecentLogsFiltered(n: number, maxLevel: number): LogEntry[] {
  if (n <= 0) return []
  const filtered: LogEntry[] = []
  for (let i = buffer.length - 1; i >= 0 && filtered.length < n; i--) {
    if (LEVEL_MAP[buffer[i].level] <= maxLevel) {
      filtered.push(buffer[i])
    }
  }
  return filtered.reverse()
}
