import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { PINNED_POST_TEXT_KEY, appAccountHandle } from '../curation/skylimitGeneral'

/**
 * Renders inline text with URLs auto-linked.
 */
function LinkifiedText({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const parts = text.split(urlRegex)

  return (
    <>
      {parts.map((part, i) =>
        urlRegex.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

/**
 * Dismissible banner for pinned messages from the app account (skylimit.dev).
 * Reads pinned post data from localStorage and listens for updates via custom event.
 */
export default function PinnedPostBanner() {
  const navigate = useNavigate()
  const [pinnedText, setPinnedText] = useState<string | null>(null)

  const readFromStorage = useCallback(() => {
    const text = localStorage.getItem(PINNED_POST_TEXT_KEY)
    setPinnedText(text)
  }, [])

  useEffect(() => {
    readFromStorage()
    window.addEventListener('pinnedPostUpdated', readFromStorage)
    return () => window.removeEventListener('pinnedPostUpdated', readFromStorage)
  }, [readFromStorage])

  const dismiss = () => {
    // Clear text so banner hides, but keep the ID so same post won't re-display
    localStorage.removeItem(PINNED_POST_TEXT_KEY)
    setPinnedText(null)
  }

  if (!pinnedText) return null

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-3 mx-2 mb-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="text-blue-800 dark:text-blue-200">
          <p className="font-semibold mb-1">Message from <span className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer" onClick={() => navigate(`/profile/${appAccountHandle}`)}>@{appAccountHandle}</span></p>
          <p><LinkifiedText text={pinnedText} /></p>
        </div>
        <button
          onClick={dismiss}
          className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 font-bold text-lg leading-none flex-shrink-0"
          aria-label="Dismiss pinned message"
        >
          &times;
        </button>
      </div>
    </div>
  )
}
