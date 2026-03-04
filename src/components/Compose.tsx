import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import Button from './Button'
import Modal from './Modal'
import QuotedPost from './QuotedPost'
import Spinner from './Spinner'
import PostCard from './PostCard'
import { extractLastUrl, fetchOGImage } from '../utils/og-image'
import { useSession } from '../auth/SessionContext'

interface ComposeProps {
  isOpen: boolean
  onClose: () => void
  replyTo?: {
    uri: string
    cid: string
    rootUri?: string
    rootCid?: string
  }
  quotePost?: AppBskyFeedDefs.PostView
  onPost: (text: string, replyTo?: ComposeProps['replyTo'], quotePost?: AppBskyFeedDefs.PostView, images?: Array<{ image: Blob; alt: string }>, ogImage?: { url: string; title: string; description: string }) => Promise<void>
  onPostThread?: (
    segments: Array<{ text: string; images: Array<{ image: Blob; alt: string }>; ogImage?: { url: string; title: string; description: string } }>,
    replyTo?: ComposeProps['replyTo']
  ) => Promise<void>
}

interface ImagePreview {
  file: File
  preview: string
  alt: string
}

interface OGImagePreview {
  url: string
  title?: string
  description?: string
}

interface ThreadSegment {
  id: string
  text: string
  images: ImagePreview[]
  ogImage: OGImagePreview | null
}

const MAX_POST_LENGTH = 300
const MAX_IMAGES = 4

function createEmptySegment(): ThreadSegment {
  return { id: crypto.randomUUID(), text: '', images: [], ogImage: null }
}

function getSuffixReserve(totalSegments: number): number {
  if (totalSegments <= 1) return 0
  const digits = String(totalSegments).length
  return 1 + digits + 1 + digits // " m/n"
}

function getEffectiveLimit(totalSegments: number): number {
  return MAX_POST_LENGTH - getSuffixReserve(totalSegments)
}

function formatSuffix(index: number, total: number): string {
  if (total <= 1) return ''
  const digits = String(total).length
  const m = String(index + 1).padStart(digits, ' ')
  // Build suffix like " 1/3" — pad with leading spaces up to max suffix length
  const suffix = `${m}/${total}`
  const maxSuffixLen = getSuffixReserve(total)
  return suffix.padStart(maxSuffixLen, ' ')
}

function redistributeText(
  segments: ThreadSegment[],
  changedIndex: number,
  newText: string
): ThreadSegment[] {
  const updated = segments.map((s, i) =>
    i === changedIndex ? { ...s, text: newText } : { ...s }
  )

  const doPass = (segs: ThreadSegment[]) => {
    const limit = getEffectiveLimit(segs.length)

    // Forward pass: push overflow at character limit
    for (let i = changedIndex; i < segs.length; i++) {
      if (segs[i].text.length > limit) {
        const overflow = segs[i].text.slice(limit)
        segs[i] = { ...segs[i], text: segs[i].text.slice(0, limit) }

        if (i + 1 < segs.length) {
          segs[i + 1] = { ...segs[i + 1], text: overflow + segs[i + 1].text }
        } else {
          segs.push({ ...createEmptySegment(), text: overflow })
        }
      }
    }

    // Backward pass: pull text back if room in changedIndex
    if (changedIndex < segs.length - 1) {
      const room = limit - segs[changedIndex].text.length
      if (room > 0 && segs[changedIndex + 1].text.length > 0) {
        const pullChars = Math.min(room, segs[changedIndex + 1].text.length)
        segs[changedIndex] = {
          ...segs[changedIndex],
          text: segs[changedIndex].text + segs[changedIndex + 1].text.slice(0, pullChars),
        }
        segs[changedIndex + 1] = {
          ...segs[changedIndex + 1],
          text: segs[changedIndex + 1].text.slice(pullChars),
        }
      }
    }

    // Remove trailing empty segments (keep min 2)
    while (
      segs.length > 2 &&
      segs[segs.length - 1].text === '' &&
      segs[segs.length - 1].images.length === 0
    ) {
      segs.pop()
    }

    return segs
  }

  doPass(updated)

  // If segment count changed, the effective limit may have shrunk — re-run forward pass
  const newLimit = getEffectiveLimit(updated.length)
  for (let i = 0; i < updated.length; i++) {
    if (updated[i].text.length > newLimit) {
      const overflow = updated[i].text.slice(newLimit)
      updated[i] = { ...updated[i], text: updated[i].text.slice(0, newLimit) }
      if (i + 1 < updated.length) {
        updated[i + 1] = { ...updated[i + 1], text: overflow + updated[i + 1].text }
      } else {
        updated.push({ ...createEmptySegment(), text: overflow })
      }
    }
  }

  return updated
}

function processFilesForSegment(
  files: FileList | File[] | null,
  currentImages: ImagePreview[],
  setError: (msg: string | null) => void
): ImagePreview[] | null {
  if (!files || (Array.isArray(files) ? files.length === 0 : files.length === 0)) return null

  const newImages: ImagePreview[] = []
  const remainingSlots = MAX_IMAGES - currentImages.length
  const fileArray = Array.isArray(files) ? files : Array.from(files)

  for (let i = 0; i < Math.min(fileArray.length, remainingSlots); i++) {
    const file = fileArray[i]
    if (!file.type.startsWith('image/')) {
      setError(`${file.name} is not an image file`)
      continue
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(`${file.name} is too large. Maximum size is 5MB`)
      continue
    }
    const preview = URL.createObjectURL(file)
    newImages.push({ file, preview, alt: '' })
  }

  if (newImages.length > 0) {
    setError(null)
    return [...currentImages, ...newImages]
  }
  return null
}

export default function Compose({ isOpen, onClose, replyTo, quotePost, onPost, onPostThread }: ComposeProps) {
  const { session } = useSession()

  // Single-mode state
  const [text, setText] = useState('')
  const [isPosting, setIsPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<ImagePreview[]>([])
  const [ogImage, setOgImage] = useState<OGImagePreview | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoadingOG, setIsLoadingOG] = useState(false)

  // Threaded mode state
  const [isThreaded, setIsThreaded] = useState(false)
  const [segments, setSegments] = useState<ThreadSegment[]>([createEmptySegment(), createEmptySegment()])
  const [previewMode, setPreviewMode] = useState(false)
  const [segmentDragging, setSegmentDragging] = useState<number | null>(null)
  const [editingAltIndex, setEditingAltIndex] = useState<{ seg: number; img: number } | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const segmentTextareaRefs = useRef<(HTMLTextAreaElement | null)[]>([])
  const segmentFileInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const cursorRestore = useRef<{ index: number; pos: number } | null>(null)
  // Track which segment's file input to target
  const activeSegmentFileInput = useRef<number>(0)

  // Focus textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      if (isThreaded) {
        segmentTextareaRefs.current[0]?.focus()
      } else {
        textareaRef.current?.focus()
      }
    }
  }, [isOpen, isThreaded])

  // Clean up on close
  useEffect(() => {
    if (!isOpen) {
      setText('')
      setImages(prevImages => {
        prevImages.forEach(img => URL.revokeObjectURL(img.preview))
        return []
      })
      setOgImage(null)
      setError(null)
      setIsThreaded(false)
      setSegments(prev => {
        prev.forEach(seg => seg.images.forEach(img => URL.revokeObjectURL(img.preview)))
        return [createEmptySegment(), createEmptySegment()]
      })
      setPreviewMode(false)
      setEditingAltIndex(null)
    }
  }, [isOpen])

  // Extract and fetch OG image from links in text (single mode only) — debounced
  const lastSingleOgUrl = useRef<string | null>(null)
  useEffect(() => {
    if (isThreaded) return
    if (images.length > 0) {
      setOgImage(null)
      lastSingleOgUrl.current = null
      return
    }

    const url = extractLastUrl(text)
    if (!url) {
      setOgImage(null)
      lastSingleOgUrl.current = null
      return
    }

    // Skip if already fetched this URL
    if (lastSingleOgUrl.current === url) return

    const timer = setTimeout(() => {
      lastSingleOgUrl.current = url
      setIsLoadingOG(true)
      fetchOGImage(url)
        .then(data => {
          setOgImage(data || null)
        })
        .catch(() => {
          setOgImage(null)
        })
        .finally(() => setIsLoadingOG(false))
    }, 800)

    return () => clearTimeout(timer)
  }, [text, images.length, isThreaded])

  // Per-segment OG image extraction (threaded mode) — debounced
  const ogFetchedUrls = useRef<Map<number, string>>(new Map()) // segIndex -> last fetched URL
  useEffect(() => {
    if (!isThreaded) {
      ogFetchedUrls.current.clear()
      return
    }

    const timer = setTimeout(() => {
      segments.forEach((seg, i) => {
        if (seg.images.length > 0) {
          if (seg.ogImage) {
            setSegments(prev => prev.map((s, j) => j === i ? { ...s, ogImage: null } : s))
          }
          ogFetchedUrls.current.delete(i)
          return
        }

        const url = extractLastUrl(seg.text)
        if (!url) {
          if (seg.ogImage) {
            setSegments(prev => prev.map((s, j) => j === i ? { ...s, ogImage: null } : s))
          }
          ogFetchedUrls.current.delete(i)
          return
        }

        // Skip if we already fetched this exact URL for this segment
        if (ogFetchedUrls.current.get(i) === url) return
        ogFetchedUrls.current.set(i, url)

        fetchOGImage(url)
          .then(data => {
            setSegments(prev => prev.map((s, j) => j === i ? { ...s, ogImage: data || null } : s))
          })
          .catch(() => {
            setSegments(prev => prev.map((s, j) => j === i ? { ...s, ogImage: null } : s))
          })
      })
    }, 500) // 500ms debounce

    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThreaded, segments.map(s => s.text + '|' + s.images.length).join(',')])

  // Restore cursor position after threaded text redistribution
  useLayoutEffect(() => {
    if (cursorRestore.current) {
      const { index, pos } = cursorRestore.current
      const ta = segmentTextareaRefs.current[index]
      if (ta) {
        const safePos = Math.min(pos, ta.value.length)
        ta.setSelectionRange(safePos, safePos)
      }
      cursorRestore.current = null
    }
  })

  // --- Single-mode handlers (unchanged) ---

  const handleFileSelect = useCallback((files: FileList | null) => {
    const result = processFilesForSegment(files, images, setError)
    if (result) {
      setImages(result)
      setOgImage(null)
    }
  }, [images])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    handleFileSelect(e.dataTransfer.files)
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const imageFiles: File[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault()
      handleFileSelect(imageFiles as any as FileList)
    }
  }

  const removeImage = (index: number) => {
    const image = images[index]
    URL.revokeObjectURL(image.preview)
    setImages(images.filter((_, i) => i !== index))
  }

  const updateImageAlt = (index: number, alt: string) => {
    const updated = [...images]
    updated[index].alt = alt
    setImages(updated)
  }

  const removeOGImage = () => {
    setOgImage(null)
  }

  // --- Threaded mode handlers ---

  const handleSegmentTextChange = useCallback((index: number, newText: string) => {
    const ta = segmentTextareaRefs.current[index]
    const cursorPos = ta?.selectionStart ?? newText.length
    cursorRestore.current = { index, pos: cursorPos }

    setSegments(prev => redistributeText(prev, index, newText))
  }, [])

  const handleSegmentImageDrop = useCallback((segIndex: number, files: FileList | File[]) => {
    setSegments(prev => {
      const seg = prev[segIndex]
      const result = processFilesForSegment(files as any, seg.images, setError)
      if (result) {
        return prev.map((s, i) => i === segIndex ? { ...s, images: result, ogImage: null } : s)
      }
      return prev
    })
  }, [])

  const handleSegmentPaste = useCallback((segIndex: number, e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const imageFiles: File[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault()
      handleSegmentImageDrop(segIndex, imageFiles)
    }
  }, [handleSegmentImageDrop])

  const removeSegmentImage = useCallback((segIndex: number, imgIndex: number) => {
    setSegments(prev => prev.map((s, i) => {
      if (i !== segIndex) return s
      const img = s.images[imgIndex]
      URL.revokeObjectURL(img.preview)
      return { ...s, images: s.images.filter((_, j) => j !== imgIndex) }
    }))
  }, [])

  const updateSegmentImageAlt = useCallback((segIndex: number, imgIndex: number, alt: string) => {
    setSegments(prev => prev.map((s, i) => {
      if (i !== segIndex) return s
      const updatedImages = [...s.images]
      updatedImages[imgIndex] = { ...updatedImages[imgIndex], alt }
      return { ...s, images: updatedImages }
    }))
  }, [])

  // --- Toggle threaded mode ---

  const toggleThreaded = useCallback(() => {
    if (!isThreaded) {
      // Switching ON: migrate single-mode content to segments
      const seg0: ThreadSegment = {
        id: crypto.randomUUID(),
        text: text,
        images: [...images],
        ogImage: ogImage,
      }
      setSegments([seg0, createEmptySegment()])
      setText('')
      setImages([])
      setOgImage(null)
      setIsThreaded(true)
    } else {
      // Switching OFF: merge segments back to single mode
      const allText = segments.map(s => s.text).join('')
      const truncated = allText.slice(0, MAX_POST_LENGTH)
      const allImages = segments.flatMap(s => s.images)
      setText(truncated)
      setImages(allImages.slice(0, MAX_IMAGES))
      setOgImage(segments[0]?.ogImage || null)
      setSegments([createEmptySegment(), createEmptySegment()])
      setIsThreaded(false)
      setPreviewMode(false)
    }
  }, [isThreaded, text, images, ogImage, segments])

  // --- Submit ---

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isThreaded) {
      // Threaded submit
      const nonEmptySegments = segments.filter(s => s.text.trim() || s.images.length > 0)
      if (nonEmptySegments.length === 0) {
        setError('Thread cannot be empty')
        return
      }

      if (!onPostThread) {
        setError('Threaded posting is not supported here')
        return
      }

      setIsPosting(true)

      try {
        const total = nonEmptySegments.length
        const segmentData = nonEmptySegments.map((seg, i) => {
          const suffix = formatSuffix(i, total)
          return {
            text: seg.text.trim() + suffix,
            images: seg.images.map(img => ({
              image: img.file as Blob,
              alt: img.alt || '',
            })),
            ogImage: seg.ogImage && seg.images.length === 0
              ? { url: seg.ogImage.url, title: seg.ogImage.title || '', description: seg.ogImage.description || '' }
              : undefined,
          }
        })

        await onPostThread(segmentData, replyTo)

        // Clean up
        segments.forEach(seg => seg.images.forEach(img => URL.revokeObjectURL(img.preview)))
        setSegments([createEmptySegment(), createEmptySegment()])
        setIsThreaded(false)
        setPreviewMode(false)
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post thread')
      } finally {
        setIsPosting(false)
      }
    } else {
      // Single-post submit (unchanged logic)
      const trimmedText = text.trim()
      if (!trimmedText && images.length === 0) {
        setError('Post cannot be empty')
        return
      }

      if (text.length > MAX_POST_LENGTH) {
        setError(`Post must be ${MAX_POST_LENGTH} characters or less`)
        return
      }

      setIsPosting(true)

      try {
        const imageBlobs = images.map(img => ({
          image: img.file as Blob,
          alt: img.alt || '',
        }))

        const ogData = ogImage && images.length === 0 ? { url: ogImage.url, title: ogImage.title || '', description: ogImage.description || '' } : undefined
        await onPost(trimmedText, replyTo, quotePost, imageBlobs.length > 0 ? imageBlobs : undefined, ogData)

        images.forEach(img => URL.revokeObjectURL(img.preview))
        setText('')
        setImages([])
        setOgImage(null)
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post')
      } finally {
        setIsPosting(false)
      }
    }
  }

  const handleClose = () => {
    if (!isPosting) {
      setText('')
      setError(null)
      onClose()
    }
  }

  // --- Preview mode helpers ---

  const buildSinglePreviewPost = (): AppBskyFeedDefs.FeedViewPost => {
    let embed: any = undefined
    if (images.length > 0) {
      embed = {
        $type: 'app.bsky.embed.images#view',
        images: images.map(img => ({
          thumb: img.preview,
          fullsize: img.preview,
          alt: img.alt || '',
          aspectRatio: undefined,
        })),
      }
    } else if (ogImage) {
      embed = {
        $type: 'app.bsky.embed.external#view',
        external: {
          uri: ogImage.url,
          title: ogImage.title || '',
          description: ogImage.description || '',
          thumb: ogImage.url,
        },
      }
    }
    return {
      post: {
        uri: `at://${session?.did || 'unknown'}/app.bsky.feed.post/preview-single`,
        cid: 'preview-cid-single',
        author: {
          did: session?.did || 'unknown',
          handle: session?.handle || 'you',
          displayName: session?.handle || 'you',
          avatar: undefined,
        },
        record: {
          $type: 'app.bsky.feed.post',
          text: text.trim(),
          createdAt: new Date().toISOString(),
        },
        embed,
        indexedAt: new Date().toISOString(),
        likeCount: 0,
        repostCount: 0,
        replyCount: 0,
      },
    } as any as AppBskyFeedDefs.FeedViewPost
  }

  const buildPreviewPosts = (): AppBskyFeedDefs.FeedViewPost[] => {
    const nonEmpty = segments.filter(s => s.text.trim() || s.images.length > 0)
    const total = nonEmpty.length
    return nonEmpty.map((seg, i) => {
      const suffix = formatSuffix(i, total)
      const fullText = seg.text.trim() + suffix

      return {
        post: {
          uri: `at://${session?.did || 'unknown'}/app.bsky.feed.post/preview-${seg.id}`,
          cid: `preview-cid-${seg.id}`,
          author: {
            did: session?.did || 'unknown',
            handle: session?.handle || 'you',
            displayName: session?.handle || 'you',
            avatar: undefined,
          },
          record: {
            $type: 'app.bsky.feed.post',
            text: fullText,
            createdAt: new Date().toISOString(),
          },
          embed: seg.images.length > 0
            ? {
                $type: 'app.bsky.embed.images#view',
                images: seg.images.map(img => ({
                  thumb: img.preview,
                  fullsize: img.preview,
                  alt: img.alt || '',
                  aspectRatio: undefined,
                })),
              }
            : seg.ogImage
              ? {
                  $type: 'app.bsky.embed.external#view',
                  external: {
                    uri: seg.ogImage.url,
                    title: seg.ogImage.title || '',
                    description: seg.ogImage.description || '',
                    thumb: seg.ogImage.url,
                  },
                }
              : undefined,
          indexedAt: new Date().toISOString(),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        },
      } as any as AppBskyFeedDefs.FeedViewPost
    })
  }

  // --- Render ---

  const remainingChars = MAX_POST_LENGTH - text.length
  const isOverLimit = remainingChars < 0
  const effectiveLimit = getEffectiveLimit(segments.length)

  const hasThreadedContent = isThreaded && segments.some(s => s.text.trim() || s.images.length > 0)
  const hasSingleContent = !isThreaded && (text.trim() || images.length > 0)

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={replyTo ? 'Reply' : quotePost ? 'Quote Post' : 'Compose Post'}
      size={isThreaded ? 'xl' : 'lg'}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Threaded mode checkbox — hidden for quote posts */}
        {!quotePost && (
          <div className="flex justify-end">
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isThreaded}
                onChange={toggleThreaded}
                disabled={isPosting}
                className="rounded border-gray-300 dark:border-gray-600"
              />
              Threaded mode
            </label>
          </div>
        )}

        {/* === SINGLE MODE — EDIT VIEW === */}
        {!isThreaded && !previewMode && (
          <>
            <div
              ref={dropZoneRef}
              className={`border-2 border-dashed rounded-lg transition-colors ${
                isDragging
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={handlePaste}
                placeholder={replyTo ? 'Write your reply...' : quotePost ? 'Add your thoughts...' : 'What\'s happening?'}
                className="w-full px-4 py-3 border-0 bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none resize-none"
                rows={6}
                disabled={isPosting}
                maxLength={MAX_POST_LENGTH + 100}
              />
              {images.length === 0 && !ogImage && (
                <div className="px-4 pb-3 text-sm text-gray-500 dark:text-gray-400">
                  Drop images here or paste them
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                handleFileSelect(e.target.files)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
              className="hidden"
              disabled={isPosting || images.length >= MAX_IMAGES}
            />

            {images.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {images.map((image, index) => (
                  <div key={index} className="relative group">
                    <img
                      src={image.preview}
                      alt={`Preview ${index + 1}`}
                      className="w-full h-32 object-cover rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={isPosting}
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                    <input
                      type="text"
                      placeholder="Alt text (optional)"
                      value={image.alt}
                      onChange={(e) => updateImageAlt(index, e.target.value)}
                      className="mt-1 w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
                      disabled={isPosting}
                    />
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="h-32 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:border-blue-500 transition-colors"
                    disabled={isPosting}
                  >
                    + Add Image
                  </button>
                )}
              </div>
            )}

            {ogImage && images.length === 0 && (
              <div className="relative group border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <img
                  src={ogImage.url}
                  alt={ogImage.title || 'Link preview'}
                  className="w-full h-48 object-cover"
                />
                <button
                  type="button"
                  onClick={removeOGImage}
                  className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  disabled={isPosting}
                  aria-label="Remove preview"
                >
                  ×
                </button>
                {ogImage.title && (
                  <div className="p-3 bg-gray-50 dark:bg-gray-800">
                    <div className="font-semibold text-sm">{ogImage.title}</div>
                    {ogImage.description && (
                      <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                        {ogImage.description}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {isLoadingOG && (
              <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-2">
                Loading link preview...
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className={`text-sm ${isOverLimit ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
                {remainingChars} characters remaining
              </span>
            </div>
          </>
        )}

        {/* === SINGLE MODE — PREVIEW VIEW === */}
        {!isThreaded && previewMode && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <PostCard post={buildSinglePreviewPost()} />
          </div>
        )}

        {/* === THREADED MODE — EDIT VIEW === */}
        {isThreaded && !previewMode && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <div className="grid" style={{ gridTemplateColumns: '1fr 7rem' }}>
              {segments.map((seg, segIdx) => {
                const charsLeft = effectiveLimit - seg.text.length
                const segDragging = segmentDragging === segIdx

                return (
                  <React.Fragment key={seg.id}>
                    {/* Textarea cell */}
                    <div
                      className={`relative border-b border-gray-200 dark:border-gray-700 last:border-b-0 transition-colors ${
                        segDragging ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                      }`}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(segIdx)
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(null)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(null)
                        handleSegmentImageDrop(segIdx, e.dataTransfer.files)
                      }}
                    >
                      <textarea
                        ref={(el) => { segmentTextareaRefs.current[segIdx] = el }}
                        value={seg.text}
                        onChange={(e) => handleSegmentTextChange(segIdx, e.target.value)}
                        onPaste={(e) => handleSegmentPaste(segIdx, e)}
                        placeholder={segIdx === 0
                          ? (replyTo ? 'Write your reply...' : 'What\'s happening?')
                          : 'Continue...'}
                        className="w-full px-4 py-3 border-0 bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none resize-none pr-20"
                        rows={4}
                        disabled={isPosting}
                      />
                      {/* Segment number overlay */}
                      <span className="absolute bottom-2 right-2 text-xs text-gray-400 dark:text-gray-500 font-mono pointer-events-none whitespace-pre">
                        {formatSuffix(segIdx, segments.length)}
                      </span>
                    </div>

                    {/* Sidebar cell */}
                    <div
                      className={`border-b border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 flex flex-col items-center justify-end p-2 gap-1 transition-colors ${
                        segDragging ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                      }`}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(segIdx)
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(null)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSegmentDragging(null)
                        handleSegmentImageDrop(segIdx, e.dataTransfer.files)
                      }}
                    >
                      {/* Image thumbnails */}
                      {seg.images.map((img, imgIdx) => (
                        <div key={imgIdx} className="relative group w-12 h-12 flex-shrink-0">
                          <img
                            src={img.preview}
                            alt={img.alt || `Image ${imgIdx + 1}`}
                            className="w-12 h-12 object-cover rounded"
                          />
                          <button
                            type="button"
                            onClick={() => removeSegmentImage(segIdx, imgIdx)}
                            className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                            disabled={isPosting}
                            aria-label="Remove image"
                          >
                            ×
                          </button>
                          {/* ALT badge */}
                          <button
                            type="button"
                            onClick={() => setEditingAltIndex(
                              editingAltIndex?.seg === segIdx && editingAltIndex?.img === imgIdx
                                ? null
                                : { seg: segIdx, img: imgIdx }
                            )}
                            className={`absolute bottom-0 left-0 text-[9px] font-bold px-1 rounded-tr transition-colors ${
                              img.alt
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-700/70 text-gray-200 opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            ALT
                          </button>
                          {/* ALT text input overlay */}
                          {editingAltIndex?.seg === segIdx && editingAltIndex?.img === imgIdx && (
                            <div className="absolute top-full left-0 mt-1 z-10" style={{ width: '10rem' }}>
                              <input
                                type="text"
                                autoFocus
                                placeholder="Alt text"
                                value={img.alt}
                                onChange={(e) => updateSegmentImageAlt(segIdx, imgIdx, e.target.value)}
                                onBlur={() => setEditingAltIndex(null)}
                                onKeyDown={(e) => { if (e.key === 'Enter') setEditingAltIndex(null) }}
                                className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 shadow-lg"
                              />
                            </div>
                          )}
                        </div>
                      ))}

                      {/* OG image thumbnail */}
                      {seg.ogImage && seg.images.length === 0 && (
                        <div className="relative group w-12 h-12 flex-shrink-0">
                          <img
                            src={seg.ogImage.url}
                            alt={seg.ogImage.title || 'Link preview'}
                            className="w-12 h-12 object-cover rounded opacity-70"
                          />
                          <button
                            type="button"
                            onClick={() => setSegments(prev => prev.map((s, i) => i === segIdx ? { ...s, ogImage: null } : s))}
                            className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                            disabled={isPosting}
                          >
                            ×
                          </button>
                        </div>
                      )}

                      {/* Add image button if no images */}
                      {seg.images.length === 0 && !seg.ogImage && (
                        <button
                          type="button"
                          onClick={() => {
                            activeSegmentFileInput.current = segIdx
                            segmentFileInputRefs.current[segIdx]?.click()
                          }}
                          className="w-12 h-12 border border-dashed border-gray-300 dark:border-gray-600 rounded flex items-center justify-center text-gray-400 hover:border-blue-400 transition-colors text-lg"
                          disabled={isPosting}
                          title="Add image"
                        >
                          +
                        </button>
                      )}

                      {/* Hidden file input per segment */}
                      <input
                        ref={(el) => { segmentFileInputRefs.current[segIdx] = el }}
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          if (e.target.files) {
                            handleSegmentImageDrop(segIdx, e.target.files)
                          }
                          e.target.value = ''
                        }}
                        className="hidden"
                        disabled={isPosting}
                      />

                      {/* Chars left */}
                      <div className={`text-[10px] mt-auto ${charsLeft < 20 ? 'text-orange-500' : 'text-gray-400 dark:text-gray-500'}`}>
                        {charsLeft} left
                      </div>
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          </div>
        )}

        {/* === THREADED MODE — PREVIEW VIEW === */}
        {isThreaded && previewMode && (
          <div className="space-y-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden max-h-[60vh] overflow-y-auto">
            {buildPreviewPosts().map((post, i) => (
              <div key={i} className="border-b last:border-b-0 border-gray-200 dark:border-gray-700">
                <PostCard post={post} />
              </div>
            ))}
          </div>
        )}

        {/* Quote post display (single mode only) */}
        {quotePost && !isThreaded && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <QuotedPost
              record={{
                $type: 'app.bsky.embed.record#view',
                record: quotePost as any,
              } as any}
            />
          </div>
        )}

        {/* Button row */}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={isPosting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPreviewMode(!previewMode)}
            disabled={isPosting || (isThreaded ? !hasThreadedContent : !hasSingleContent)}
          >
            {previewMode ? 'Edit' : 'Preview'}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isPosting || (!hasThreadedContent && !hasSingleContent) || (!isThreaded && isOverLimit)}
          >
            {isPosting ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" />
                Posting...
              </span>
            ) : (
              'Post'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
