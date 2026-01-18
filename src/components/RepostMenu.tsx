import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface RepostMenuProps {
  onRepost: () => void
  onQuotePost: () => void
  onClose: () => void
  position: { x: number; y: number }
}

export default function RepostMenu({ onRepost, onQuotePost, onClose, position }: RepostMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // Ensure menu doesn't overflow viewport on the right
  const menuWidth = 200 // min-w-[200px]
  const adjustedX = Math.min(position.x, window.innerWidth - menuWidth - 16)

  return createPortal(
    <div
      ref={menuRef}
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
          onRepost()
        }}
        role="menuitem"
      >
        Repost
      </button>
      <button
        className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          onQuotePost()
        }}
        role="menuitem"
      >
        Quote Post
      </button>
    </div>,
    document.body
  )
}
