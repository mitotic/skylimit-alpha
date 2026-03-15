import { useNavigate } from 'react-router-dom'
import { AppBskyRichtextFacet } from '@atproto/api'

interface RichTextProps {
  text: string
  facets?: AppBskyRichtextFacet.Main[]
  className?: string
}

interface TextSegment {
  text: string
  type: 'text' | 'link' | 'mention' | 'tag'
  uri?: string      // For links
  handle?: string   // For mentions (extracted from text)
  tag?: string      // For hashtags
}

/**
 * Build text segments from facets, handling byte offsets correctly
 */
function buildSegments(text: string, facets: AppBskyRichtextFacet.Main[]): TextSegment[] {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  const decoder = new TextDecoder()

  // Sort facets by byte start position
  const sortedFacets = [...facets].sort(
    (a, b) => a.index.byteStart - b.index.byteStart
  )

  const segments: TextSegment[] = []
  let currentBytePos = 0

  for (const facet of sortedFacets) {
    const { byteStart, byteEnd } = facet.index

    // Skip invalid facets
    if (byteStart < 0 || byteEnd > bytes.length || byteStart >= byteEnd) {
      continue
    }

    // Skip if overlapping with previous segment
    if (byteStart < currentBytePos) {
      continue
    }

    // Add plain text before this facet
    if (byteStart > currentBytePos) {
      const plainText = decoder.decode(bytes.slice(currentBytePos, byteStart))
      segments.push({ text: plainText, type: 'text' })
    }

    // Extract facet text
    const facetText = decoder.decode(bytes.slice(byteStart, byteEnd))

    // Determine facet type from features
    const feature = facet.features[0]
    if (!feature) {
      // No feature, render as plain text
      segments.push({ text: facetText, type: 'text' })
    } else if (feature.$type === 'app.bsky.richtext.facet#link') {
      segments.push({
        text: facetText,
        type: 'link',
        uri: (feature as AppBskyRichtextFacet.Link).uri
      })
    } else if (feature.$type === 'app.bsky.richtext.facet#mention') {
      const handle = facetText.startsWith('@') ? facetText.slice(1) : facetText
      segments.push({
        text: facetText,
        type: 'mention',
        handle
      })
    } else if (feature.$type === 'app.bsky.richtext.facet#tag') {
      segments.push({
        text: facetText,
        type: 'tag',
        tag: (feature as AppBskyRichtextFacet.Tag).tag
      })
    } else {
      // Unknown facet type, render as plain text
      segments.push({ text: facetText, type: 'text' })
    }

    currentBytePos = byteEnd
  }

  // Add remaining text after last facet
  if (currentBytePos < bytes.length) {
    const remainingText = decoder.decode(bytes.slice(currentBytePos))
    segments.push({ text: remainingText, type: 'text' })
  }

  return segments
}

/**
 * Truncate URL for display: strip protocol, truncate to ~30 chars
 */
function truncateUrl(text: string): string {
  let display = text.replace(/^https?:\/\//, '')
  if (display.length > 30) {
    display = display.slice(0, 27) + '...'
  }
  return display
}

/**
 * RichText component that renders post text with clickable links, mentions, and hashtags
 */
export default function RichText({ text, facets, className }: RichTextProps) {
  const navigate = useNavigate()

  // If no facets or empty facets, render plain text
  if (!facets || facets.length === 0) {
    return <span className={className}>{text}</span>
  }

  // Build segments from facets
  const segments = buildSegments(text, facets)

  // Render segments
  return (
    <span className={className}>
      {segments.map((segment, index) => {
        const handleClick = (e: React.MouseEvent) => {
          e.stopPropagation() // Prevent post click navigation
        }

        switch (segment.type) {
          case 'link':
            return (
              <a
                key={index}
                href={segment.uri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleClick}
                className="text-blue-500 dark:text-blue-400 hover:underline"
              >
                {truncateUrl(segment.text)}
              </a>
            )

          case 'mention':
            return (
              <span
                key={index}
                onClick={(e) => {
                  handleClick(e)
                  if (segment.handle) {
                    navigate(`/profile/${segment.handle}`)
                  }
                }}
                className="text-blue-500 dark:text-blue-400 hover:underline cursor-pointer"
              >
                {segment.text}
              </span>
            )

          case 'tag':
            return <span key={index}>{segment.text}</span>

          default:
            return <span key={index}>{segment.text}</span>
        }
      })}
    </span>
  )
}
