import { useState } from 'react'
import { AppBskyEmbedImages, AppBskyEmbedExternal, AppBskyEmbedVideo } from '@atproto/api'
import Modal from './Modal'
import QuotedPost from './QuotedPost'
import VideoPlayer from './VideoPlayer'

type EmbedView =
  | AppBskyEmbedImages.View
  | AppBskyEmbedExternal.View
  | AppBskyEmbedVideo.View
  | { $type: string; [k: string]: unknown }

interface PostMediaProps {
  embed: EmbedView | any
  maxDepth?: number
  depth?: number
}

export default function PostMedia({ embed, maxDepth = 1, depth = 0 }: PostMediaProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null)

  // Handle images
  if (embed.$type === 'app.bsky.embed.images#view' || embed.$type === 'app.bsky.embed.images') {
    const imagesEmbed = embed as AppBskyEmbedImages.View
    const images = imagesEmbed.images || []
    
    if (images.length === 0) return null

    return (
      <>
        <div className={`grid gap-2 rounded-lg overflow-hidden max-w-[500px] mx-auto ${
          images.length === 1 ? 'grid-cols-1' :
          images.length === 2 ? 'grid-cols-2' :
          images.length === 3 ? 'grid-cols-2' :
          'grid-cols-2'
        }`}>
          {images.map((image, idx) => {
            // Handle both View format (with thumb) and direct format
            const thumbUrl = (image as any).thumb || (image as any).image?.ref?.$link || ''
            const fullUrl = (image as any).fullsize || thumbUrl || ''
            const aspectRatio = image.aspectRatio
              ? image.aspectRatio.width / image.aspectRatio.height
              : (image as any).aspectRatio?.width && (image as any).aspectRatio?.height
              ? (image as any).aspectRatio.width / (image as any).aspectRatio.height
              : 1

            if (!thumbUrl) {
              console.warn('Image missing thumb URL:', image)
              return null
            }

            return (
              <div
                key={idx}
                className="relative cursor-pointer overflow-hidden bg-gray-100 dark:bg-gray-800 rounded-lg max-h-[50vh]"
                style={{
                  aspectRatio: aspectRatio.toString(),
                }}
                onClick={() => setSelectedImage(fullUrl)}
              >
                <img
                  src={thumbUrl}
                  alt={(image as any).alt || image.alt || 'Post image'}
                  className="w-full h-full object-cover object-top hover:opacity-90 transition-opacity"
                  loading="lazy"
                  onError={(e) => {
                    console.error('Failed to load image:', thumbUrl)
                    ;(e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </div>
            )
          })}
        </div>

        {selectedImage && (
          <Modal
            isOpen={!!selectedImage}
            onClose={() => setSelectedImage(null)}
            size="xl"
          >
            <img
              src={selectedImage}
              alt="Full size image"
              className="max-w-full max-h-[80vh] object-contain mx-auto"
            />
          </Modal>
        )}
      </>
    )
  }

  // Handle external links/embeds
  if (embed.$type === 'app.bsky.embed.external#view' || embed.$type === 'app.bsky.embed.external') {
    const external = embed as any as AppBskyEmbedExternal.View
    const externalData = external.external || external
    const thumbUrl = externalData?.thumb && typeof externalData.thumb === 'string' ? externalData.thumb : null
    const uri = typeof externalData?.uri === 'string' ? externalData.uri : ''
    const title = typeof externalData?.title === 'string' ? externalData.title : ''
    const description = typeof externalData?.description === 'string' ? externalData.description : ''
    
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden max-w-[500px] mx-auto">
        {thumbUrl && (
          <img
            src={thumbUrl}
            alt=""
            className="w-full h-48 object-cover"
            loading="lazy"
          />
        )}
        <div className="p-3">
          <a
            href={uri}
            target="_blank"
            rel="noopener noreferrer"
            className="block hover:opacity-80 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div className="font-semibold text-sm mb-1">{title}</div>
            )}
            {description && (
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-1 line-clamp-2">
                {description}
              </div>
            )}
            <div className="text-xs text-gray-500 dark:text-gray-500 truncate">{uri}</div>
          </a>
        </div>
      </div>
    )
  }

  // Handle video embeds
  if (embed.$type === 'app.bsky.embed.video#view' || embed.$type === 'app.bsky.embed.video') {
    const videoEmbed = embed as AppBskyEmbedVideo.View
    return (
      <VideoPlayer
        playlist={videoEmbed.playlist}
        thumbnail={videoEmbed.thumbnail}
        alt={videoEmbed.alt}
        aspectRatio={videoEmbed.aspectRatio}
      />
    )
  }

  // Handle record embeds (quoted posts) - these should be handled by QuotedPost component
  // Only display if we haven't reached max depth
  if (embed.$type === 'app.bsky.embed.record#view' || embed.$type === 'app.bsky.embed.record') {
    if (depth >= maxDepth) {
      // Don't display nested quoted posts beyond max depth
      return (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Nested quote (click to view)
          </p>
        </div>
      )
    }
    return (
      <div>
        <QuotedPost record={embed as any} maxDepth={maxDepth} depth={depth} />
      </div>
    )
  }

  // Handle record with media
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view' || embed.$type === 'app.bsky.embed.recordWithMedia') {
    const recordWithMedia = embed as any
    return (
      <div>
        {recordWithMedia.media && (
          <div>
            <PostMedia embed={recordWithMedia.media} maxDepth={maxDepth} depth={depth} />
          </div>
        )}
        {recordWithMedia.record && (
          <div className="mt-2">
            {depth >= maxDepth ? (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                  Nested quote (click to view)
                </p>
              </div>
            ) : (
              <QuotedPost record={recordWithMedia.record} maxDepth={maxDepth} depth={depth} />
            )}
          </div>
        )}
      </div>
    )
  }

  // Fallback: log unknown embed types in development
  if (process.env.NODE_ENV === 'development') {
    console.warn('Unknown embed type:', embed.$type, embed)
  }

  return null
}

