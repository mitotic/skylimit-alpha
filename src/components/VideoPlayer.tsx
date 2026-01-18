import { useState, useRef, useEffect } from 'react'
import Hls from 'hls.js'

interface VideoPlayerProps {
  playlist: string
  thumbnail?: string
  alt?: string
  aspectRatio?: { width: number; height: number }
}

export default function VideoPlayer({ playlist, thumbnail, alt, aspectRatio }: VideoPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)

  const ratio = aspectRatio
    ? aspectRatio.width / aspectRatio.height
    : 16 / 9

  useEffect(() => {
    if (!isPlaying || !videoRef.current) return

    const video = videoRef.current

    // Check if HLS is natively supported (Safari)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlist
      video.play().catch((err) => {
        console.error('Video play error:', err)
        setError('Failed to play video')
      })
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      })
      hlsRef.current = hls

      hls.loadSource(playlist)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.error('Video play error:', err)
          setError('Failed to play video')
        })
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.error('HLS fatal error:', data)
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Network error loading video')
              hls.startLoad()
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Media error')
              hls.recoverMediaError()
              break
            default:
              setError('Failed to load video')
              hls.destroy()
              break
          }
        }
      })
    } else {
      setError('Video playback not supported in this browser')
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [isPlaying, playlist])

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsPlaying(true)
  }

  if (error) {
    return (
      <div
        className="relative bg-gray-900 rounded-lg overflow-hidden w-full max-w-[500px] mx-auto flex items-center justify-center"
        style={{ aspectRatio: ratio.toString() }}
      >
        <div className="text-center text-gray-400 p-4">
          <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    )
  }

  if (!isPlaying) {
    return (
      <div
        className="relative bg-gray-900 rounded-lg overflow-hidden w-full max-w-[500px] mx-auto cursor-pointer group"
        style={{ aspectRatio: ratio.toString() }}
        onClick={handlePlay}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={alt || 'Video thumbnail'}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gray-800" />
        )}

        {/* Play button overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
          <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center group-hover:scale-110 transition-transform">
            <svg
              className="w-8 h-8 text-white ml-1"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        {/* Video indicator */}
        <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs flex items-center gap-1">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
          </svg>
          Video
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative bg-black rounded-lg overflow-hidden w-full max-w-[500px] mx-auto"
      style={{ aspectRatio: ratio.toString() }}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        controls
        playsInline
        onClick={(e) => e.stopPropagation()}
      >
        Your browser does not support video playback.
      </video>
    </div>
  )
}
