import { useState, useEffect } from 'react'
import { checkForVersionChange, isReleaseDismissed, dismissRelease, fetchReleaseNotes } from '../utils/versionCheck'

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
 * Dismissible banner showing release notes after a version update.
 * Appears once per version change, styled like PinnedPostBanner.
 */
export default function ReleaseBanner() {
  const [releaseMessage, setReleaseMessage] = useState<string | null>(null)
  const [releaseVersion, setReleaseVersion] = useState<string>('')

  useEffect(() => {
    const isNewVersion = checkForVersionChange()
    if (!isNewVersion || isReleaseDismissed()) return

    fetchReleaseNotes().then(notes => {
      if (notes) {
        setReleaseMessage(notes.message)
        setReleaseVersion(notes.version)
      }
    })
  }, [])

  const dismiss = () => {
    dismissRelease()
    setReleaseMessage(null)
  }

  if (!releaseMessage) return null

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-3 mx-2 mb-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="text-blue-800 dark:text-blue-200">
          <p className="font-semibold mb-1">Skylimit Release {releaseVersion}</p>
          <p><LinkifiedText text={releaseMessage} /></p>
        </div>
        <button
          onClick={dismiss}
          className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 font-bold text-lg leading-none flex-shrink-0"
          aria-label="Dismiss release message"
        >
          &times;
        </button>
      </div>
    </div>
  )
}
