import { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface PostOptionsMenuProps {
  isOwnPost: boolean
  onCopyText: () => void
  onPinPost?: () => void
  onDeletePost?: () => void
  onClose: () => void
  position: { x: number; y: number }
}

export default function PostOptionsMenu({ isOwnPost, onCopyText, onPinPost, onDeletePost, onClose, position }: PostOptionsMenuProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  // Ensure menu doesn't overflow viewport on the right
  const menuWidth = 200
  const adjustedX = Math.min(position.x, window.innerWidth - menuWidth - 16)

  return createPortal(
    <>
      {/* Transparent backdrop to capture outside clicks without propagating to page */}
      <div
        className="fixed inset-0 z-40"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <div
        className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2 min-w-[200px] max-w-[calc(100vw-2rem)]"
        style={{
          left: `${Math.max(8, adjustedX)}px`,
          top: `${position.y}px`,
        }}
        role="menu"
        onClick={(e) => e.stopPropagation()}
      >
      <button
        className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          onCopyText()
          onClose()
        }}
        role="menuitem"
      >
        Copy post text
      </button>
      {isOwnPost && onPinPost && (
        <button
          className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onPinPost()
            onClose()
          }}
          role="menuitem"
        >
          Pin to my profile
        </button>
      )}
      {isOwnPost && onDeletePost && (
        <button
          className="w-full px-4 py-2 text-left text-red-500 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDeletePost()
            onClose()
          }}
          role="menuitem"
        >
          Delete post
        </button>
      )}
    </div>
    </>,
    document.body
  )
}
