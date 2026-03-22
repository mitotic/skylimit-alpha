import React from 'react'
import { useNavigate } from 'react-router-dom'
import { introMessage } from '../data/helpGlossary'
import { appAccountHandle } from '../curation/skylimitGeneral'

interface HelpMessageProps {
  showInitWarning?: boolean
  readOnlyNote?: string
  showTitle?: boolean
}

/**
 * Parses a text string and returns React nodes with:
 * - _text_ rendered as <em>
 * - @handle rendered as clickable profile links
 * - https://... URLs rendered as <a> hyperlinks
 */
export function renderFormattedText(
  text: string,
  navigate: ReturnType<typeof useNavigate>
): React.ReactNode[] {
  // Substitute {appAccountHandle} template variable
  const resolved = text.replace(/\{appAccountHandle\}/g, appAccountHandle)
  // Split on patterns: _emphasis_, @handle, or https:// URLs
  const parts = resolved.split(/(_[^_]+_|@[\w.-]+|https?:\/\/[^\s,)]+)/g)
  return parts.map((part, i) => {
    if (part.startsWith('_') && part.endsWith('_')) {
      return <em key={i}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('@')) {
      const handle = part.slice(1)
      return (
        <span
          key={i}
          className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          onClick={() => navigate(`/profile/${handle}`)}
        >
          {part}
        </span>
      )
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          {part.replace(/^https?:\/\//, '').replace(/#.*$/, '')}
        </a>
      )
    }
    return part
  })
}

export default function HelpMessage({ showInitWarning, readOnlyNote, showTitle = true }: HelpMessageProps) {
  const navigate = useNavigate()

  return (
    <>
      {showInitWarning && (
        <p className="text-red-600 dark:text-red-400 mb-2">
          {introMessage.initWarning}
          {readOnlyNote && ` ${readOnlyNote}`}
        </p>
      )}
      {showTitle && <p className="font-bold mb-1">{introMessage.header}</p>}
      <ul className="list-disc list-inside mt-1 space-y-1">
        {introMessage.bullets.map((bullet, i) => (
          <li key={i}>{renderFormattedText(bullet, navigate)}</li>
        ))}
      </ul>
    </>
  )
}
