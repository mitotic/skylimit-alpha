import { useState, useMemo, useRef, useEffect } from 'react'
import { BskyAgent } from '@atproto/api'
import Modal from './Modal'
import { getRecentLogsFiltered, type LogEntry } from '../utils/logBuffer'
import { appAccountHandle } from '../curation/skylimitGeneral'
import { getFollow } from '../curation/skylimitCache'
import { getOrCreateConversation, sendMessage, isAppPasswordDMError } from '../api/chat'

interface BugReportModalProps {
  isOpen: boolean
  onClose: () => void
  initialLogLevel: number // from settings.consoleLogLevel
  onSubmitSuccess?: () => void
  agent?: BskyAgent | null
  onDmSubmitSuccess?: () => void
}

const LOG_COUNT_OPTIONS = [0, 5, 10, 25, 50, 100, 200]

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatLogEntry(entry: LogEntry): string {
  return `[${formatTimestamp(entry.timestamp)}] [${entry.level.toUpperCase()}] ${entry.message}`
}

// Show "Submit to Claude" when running on a dev server (non-privileged port or Codespaces)
function isDevServer(): boolean {
  const { port, origin } = window.location
  if (origin.includes('.app.github.dev')) return true
  const portNum = port ? parseInt(port, 10) : (location.protocol === 'https:' ? 443 : 80)
  return portNum >= 1024
}

export default function BugReportModal({ isOpen, onClose, initialLogLevel, onSubmitSuccess, agent, onDmSubmitSuccess }: BugReportModalProps) {
  const [reportText, setReportText] = useState('')
  const [logCount, setLogCount] = useState(25)
  const [logLevel, setLogLevel] = useState(initialLogLevel)
  const [preview, setPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitStatus, setSubmitStatus] = useState<{ mode: string; responseFile?: string } | null>(null)
  const [submitError, setSubmitError] = useState(false)
  const [submitErrorMsg, setSubmitErrorMsg] = useState<string | null>(null)
  const [attachedImage, setAttachedImage] = useState<{ file: File; dataUrl: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const showSubmit = isDevServer()
  const [showDmSubmit, setShowDmSubmit] = useState(false)
  const [appAccountDid, setAppAccountDid] = useState<string | null>(null)
  // Check if app account follows the user (for DM submit on production)
  useEffect(() => {
    if (!isOpen || showSubmit) return // Only check on production
    getFollow(appAccountHandle).then(follow => {
      if (follow?.followedBy && follow.accountDid) {
        setShowDmSubmit(true)
        setAppAccountDid(follow.accountDid)
      } else {
        setShowDmSubmit(false)
        setAppAccountDid(null)
      }
    }).catch(() => {
      setShowDmSubmit(false)
    })
  }, [isOpen, showSubmit])

  const logEntries = useMemo(() => {
    if (logCount === 0) return []
    return getRecentLogsFiltered(logCount, logLevel)
  }, [logCount, logLevel, preview]) // refresh when toggling preview too

  const formattedLogs = useMemo(
    () => logEntries.map(formatLogEntry).join('\n'),
    [logEntries]
  )

  const previewText = useMemo(() => {
    const parts = [reportText.trim()]
    if (logCount > 0 && formattedLogs) {
      parts.push(`\n--- Console log (${logEntries.length} entries, level ≤ ${logLevel}) ---\n`)
      parts.push(formattedLogs)
    }
    return parts.join('\n')
  }, [reportText, logCount, formattedLogs, logEntries.length, logLevel])

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setAttachedImage({ file, dataUrl: reader.result as string })
    }
    reader.readAsDataURL(file)
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(previewText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback: select all text in the pre block
    }
  }

  function handleClose() {
    setPreview(false)
    onClose()
  }

  async function handleSubmit() {
    setSubmitting(true)
    setSubmitStatus(null)
    setSubmitError(false)
    try {
      const payload: { report: string; image?: string; imageName?: string } = { report: previewText }
      if (attachedImage) {
        payload.image = attachedImage.dataUrl
        payload.imageName = attachedImage.file.name
      }
      const resp = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) throw new Error('Server error')
      await resp.json()
      handleClose()
      onSubmitSuccess?.()
    } catch {
      setSubmitError(true)
      setTimeout(() => setSubmitError(false), 3000)
    } finally {
      setSubmitting(false)
    }
  }

  // Split text into chunks that fit within Bluesky's 1000-grapheme DM limit.
  // Uses Intl.Segmenter for accurate grapheme counting.
  function splitForDm(text: string): string[] {
    const MAX_GRAPHEMES = 900 // Leave room for [n/m] prefix (Bluesky DM limit is 1000 graphemes)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segmenter = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' })

    function graphemeLength(s: string): number {
      let count = 0
      for (const _ of segmenter.segment(s)) { count++; void _ }
      return count
    }

    if (graphemeLength(text) <= MAX_GRAPHEMES) return [text]

    const chunks: string[] = []
    const lines = text.split('\n')
    let current = ''
    for (const line of lines) {
      const candidate = current ? current + '\n' + line : line
      if (graphemeLength(candidate) > MAX_GRAPHEMES) {
        if (current) chunks.push(current)
        // If a single line exceeds the limit, hard-split it
        if (graphemeLength(line) > MAX_GRAPHEMES) {
          let remaining = line
          while (graphemeLength(remaining) > MAX_GRAPHEMES) {
            // Take MAX_GRAPHEMES graphemes
            let taken = ''
            let count = 0
            for (const seg of segmenter.segment(remaining)) {
              if (count >= MAX_GRAPHEMES) break
              taken += seg.segment
              count++
            }
            chunks.push(taken)
            remaining = remaining.slice(taken.length)
          }
          current = remaining
        } else {
          current = line
        }
      } else {
        current = candidate
      }
    }
    if (current) chunks.push(current)
    return chunks
  }

  async function handleDmSubmit() {
    if (!agent || !appAccountDid) return
    setSubmitting(true)
    setSubmitError(false)
    setSubmitErrorMsg(null)
    try {
      const { convo } = await getOrCreateConversation(agent, appAccountDid)
      const chunks = splitForDm(previewText)
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : ''
        await sendMessage(agent, convo.id, { text: prefix + chunks[i] })
      }
      handleClose()
      onDmSubmitSuccess?.()
    } catch (err) {
      setSubmitError(true)
      if (isAppPasswordDMError(err)) {
        setSubmitErrorMsg('App password lacks DM access')
      }
      setTimeout(() => { setSubmitError(false); setSubmitErrorMsg(null) }, 5000)
    } finally {
      setSubmitting(false)
    }
  }

  const titleExtra = (
    <div className="flex gap-2 ml-auto">
      {preview && showSubmit && (
        <button
          onClick={handleSubmit}
          disabled={submitting || !previewText.trim()}
          className="px-3 py-1 text-sm rounded bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
        >
          {submitting ? 'Submitting...'
            : submitStatus ? (submitStatus.mode === 'terminal' ? 'Sent!' : `Sent!`)
            : submitError ? 'Failed'
            : 'Submit to Claude'}
        </button>
      )}
      {preview && showDmSubmit && !showSubmit && (
        <button
          onClick={handleDmSubmit}
          disabled={submitting || !previewText.trim() || !agent}
          className="px-3 py-1 text-sm rounded bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
        >
          {submitting ? 'Sending...'
            : submitError ? (submitErrorMsg || 'Failed')
            : `DM @${appAccountHandle}`}
        </button>
      )}
      <button
        onClick={() => setPreview(!preview)}
        className="px-3 py-1 text-sm rounded bg-blue-500 hover:bg-blue-600 text-white"
      >
        {preview ? 'Edit' : 'Preview'}
      </button>
      {preview && (
        <button
          onClick={handleCopy}
          className="px-3 py-1 text-sm rounded bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      )}
    </div>
  )

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Report" titleExtra={titleExtra} size="lg" mobileFullHeight>
      {preview ? (
        <div className="max-h-[60vh] overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words text-sm font-mono bg-gray-50 dark:bg-gray-900 p-4 rounded">
            {previewText}
          </pre>
          {attachedImage && (
            <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900 rounded">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Attached: {attachedImage.file.name}</p>
              <img
                src={attachedImage.dataUrl}
                alt="Attached screenshot"
                className="w-full rounded border border-gray-200 dark:border-gray-700"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            placeholder="Describe the bug..."
            rows={6}
            className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          {showSubmit && (
            <div className="flex items-center gap-3 text-sm">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600"
              >
                Attach image
              </button>
              {attachedImage && (
                <div className="flex items-center gap-2">
                  <img
                    src={attachedImage.dataUrl}
                    alt="Attached"
                    className="h-10 w-10 object-cover rounded border border-gray-300 dark:border-gray-600"
                  />
                  <span className="text-gray-500 dark:text-gray-400 text-xs truncate max-w-[120px]">
                    {attachedImage.file.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachedImage(null)}
                    className="text-gray-400 hover:text-red-500 text-xs"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
            <span>Log level:</span>
            <select
              value={logLevel}
              onChange={(e) => setLogLevel(Number(e.target.value))}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            >
              <option value={0}>0 - Errors</option>
              <option value={1}>1 - Warnings</option>
              <option value={2}>2 - Milestones</option>
              <option value={3}>3 - Debug</option>
              <option value={4}>4 - Verbose</option>
            </select>
          </div>

          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <span>Here are the</span>
            <select
              value={logCount}
              onChange={(e) => setLogCount(Number(e.target.value))}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            >
              {LOG_COUNT_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>most recent console log messages:</span>
          </div>

          {logCount > 0 && (
            <pre className="whitespace-pre-wrap break-words text-xs font-mono bg-gray-50 dark:bg-gray-900 p-3 rounded max-h-[40vh] overflow-y-auto border border-gray-200 dark:border-gray-700">
              {formattedLogs || '(no log messages at this level)'}
            </pre>
          )}
        </div>
      )}
    </Modal>
  )
}
