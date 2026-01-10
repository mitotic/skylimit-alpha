import React, { useState, useRef, useCallback, useEffect } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import Button from './Button'
import Modal from './Modal'
import QuotedPost from './QuotedPost'
import Spinner from './Spinner'
import { extractLastUrl, fetchOGImage } from '../utils/og-image'

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
  onPost: (text: string, replyTo?: ComposeProps['replyTo'], quotePost?: AppBskyFeedDefs.PostView, images?: Array<{ image: Blob; alt: string }>) => Promise<void>
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

const MAX_POST_LENGTH = 300
const MAX_IMAGES = 4

export default function Compose({ isOpen, onClose, replyTo, quotePost, onPost }: ComposeProps) {
  const [text, setText] = useState('')
  const [isPosting, setIsPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<ImagePreview[]>([])
  const [ogImage, setOgImage] = useState<OGImagePreview | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoadingOG, setIsLoadingOG] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  // Focus textarea when modal opens
  React.useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isOpen])

  // Clean up on close
  React.useEffect(() => {
    if (!isOpen) {
      // Clean up on close
      setText('')
      setImages(prevImages => {
        prevImages.forEach(img => URL.revokeObjectURL(img.preview))
        return []
      })
      setOgImage(null)
      setError(null)
    }
  }, [isOpen])

  // Extract and fetch OG image from links in text
  useEffect(() => {
    // Only fetch OG image if no user-dropped images
    if (images.length > 0) {
      setOgImage(null)
      return
    }

    const url = extractLastUrl(text)
    if (!url) {
      setOgImage(null)
      return
    }

    setIsLoadingOG(true)
    fetchOGImage(url)
      .then(data => {
        if (data) {
          setOgImage(data)
        } else {
          setOgImage(null)
        }
      })
      .catch(() => {
        setOgImage(null)
      })
      .finally(() => {
        setIsLoadingOG(false)
      })
  }, [text, images.length])

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return

    const newImages: ImagePreview[] = []
    const remainingSlots = MAX_IMAGES - images.length

    for (let i = 0; i < Math.min(files.length, remainingSlots); i++) {
      const file = files[i]
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
      setImages([...images, ...newImages])
      setError(null)
      // Dropped images override OG image
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
      const fileList = imageFiles as any as FileList
      handleFileSelect(fileList)
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

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
      // Convert images to blobs
      const imageBlobs = images.map(img => ({
        image: img.file as Blob,
        alt: img.alt || '',
      }))

      await onPost(trimmedText, replyTo, quotePost, imageBlobs.length > 0 ? imageBlobs : undefined)
      
      // Clean up
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

  const handleClose = () => {
    if (!isPosting) {
      setText('')
      setError(null)
      onClose()
    }
  }

  const remainingChars = MAX_POST_LENGTH - text.length
  const isOverLimit = remainingChars < 0

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={replyTo ? 'Reply' : quotePost ? 'Quote Post' : 'Compose Post'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

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
            if (fileInputRef.current) {
              fileInputRef.current.value = ''
            }
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

        {quotePost && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <QuotedPost
              record={{
                $type: 'app.bsky.embed.record',
                record: quotePost as any,
              }}
            />
          </div>
        )}

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
            type="submit"
            variant="primary"
            disabled={isPosting || (!text.trim() && images.length === 0) || isOverLimit}
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

