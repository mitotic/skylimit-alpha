/**
 * Centralized logging system for Websky
 *
 * 5 levels: 0=errors, 1=warnings, 2=milestones, 3=debug, 4=verbose
 * Default level: 2 (milestones)
 *
 * Usage:
 *   import log from '../utils/logger'
 *   log.error('Feed', 'Failed to load:', error)    // Level 0: always shown
 *   log.warn('Prefetch', 'Cursor fetch failed')     // Level 1+
 *   log.info('Feed', 'Fetched 42 posts')            // Level 2+: milestone events
 *   log.debug('Prefetch', 'Cache exhausted')         // Level 3+: operational detail
 *   log.verbose('Paged Updates/Probe', 'Probing...') // Level 4: high-frequency
 *
 * Output format: [Topic]-level message
 */

let cachedLevel = 2
let traceUsers: Set<string> = new Set()

function formatPrefix(topic: string, level: number): string {
  return `[${topic}]-${level}`
}

function parseTraceUsers(csv: string): Set<string> {
  return new Set(csv.split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))
}

const log = {
  /** Level 0: Error messages -- always shown regardless of log level */
  error(topic: string, ...args: unknown[]) {
    console.error(formatPrefix(topic, 0), ...args)
  },

  /** Level 1: Warning messages -- shown at level 1+ */
  warn(topic: string, ...args: unknown[]) {
    if (cachedLevel >= 1) console.warn(formatPrefix(topic, 1), ...args)
  },

  /** Level 2: Milestone events -- shown at level 2+ */
  info(topic: string, ...args: unknown[]) {
    if (cachedLevel >= 2) console.log(formatPrefix(topic, 2), ...args)
  },

  /** Level 3: Debug messages -- shown at level 3+ */
  debug(topic: string, ...args: unknown[]) {
    if (cachedLevel >= 3) console.log(formatPrefix(topic, 3), ...args)
  },

  /** Level 4: Verbose/high-frequency messages -- shown only at level 4 */
  verbose(topic: string, ...args: unknown[]) {
    if (cachedLevel >= 4) console.log(formatPrefix(topic, 4), ...args)
  },

  /** Trace log for specific users — always shown when user is in trace set, regardless of log level */
  trace(subtopic: string, handle: string, postTimestamp: number, postText: string, extra?: string) {
    if (traceUsers.size === 0 || !traceUsers.has(handle.toLowerCase())) return
    const d = new Date(postTimestamp)
    const dateStr = d.toLocaleDateString()
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const text20 = (postText || '').substring(0, 20)
    const msg = `@${handle} ${dateStr} ${timeStr} "${text20}"${extra ? ' ' + extra : ''}`
    console.log(formatPrefix(`Trace/${subtopic}`, 2), msg)
  },

  /** Update trace user set from comma-separated string */
  setTraceUsers(csv: string) {
    traceUsers = parseTraceUsers(csv)
  },

  /** Check if a handle is being traced */
  isTraced(handle: string): boolean {
    return traceUsers.size > 0 && traceUsers.has(handle.toLowerCase())
  },

  /** Set log level immediately (0-4) */
  setLevel(level: number) {
    cachedLevel = Math.max(0, Math.min(4, level))
  },

  /** Get current cached log level */
  getLevel() {
    return cachedLevel
  },

  /** Refresh log level and trace users from IndexedDB settings */
  async refreshLevel() {
    try {
      // Dynamic import avoids circular deps (logger is in utils/, settings in curation/)
      const { getSetting } = await import('../curation/skylimitStore')
      cachedLevel = (await getSetting('consoleLogLevel')) ?? 2
      const traceStr = (await getSetting('traceUsers')) ?? ''
      traceUsers = parseTraceUsers(traceStr)
    } catch {
      // If settings can't be read (e.g., DB not initialized), keep current level
    }
  },
}

export default log
