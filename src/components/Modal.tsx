import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  titleExtra?: React.ReactNode
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  mobileFullHeight?: boolean
}

export default function Modal({ isOpen, onClose, title, titleExtra, children, size = 'md', mobileFullHeight = false }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex ${mobileFullHeight ? 'items-stretch sm:items-center' : 'items-center'} justify-center p-0 sm:p-4 bg-black bg-opacity-50`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
    >
      <div
        className={`bg-white dark:bg-gray-800 sm:rounded-lg shadow-xl w-full ${sizeClasses[size]} max-h-[95vh] sm:max-h-[90vh] ${mobileFullHeight ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 id="modal-title" className="text-xl font-semibold">
              {title}
            </h2>
            {titleExtra && <div className="flex items-center">{titleExtra}</div>}
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 focus:outline-none"
              aria-label="Close modal"
            >
              ×
            </button>
          </div>
        )}
        <div className={`p-4${mobileFullHeight ? ' flex-1 overflow-y-auto min-h-0' : ''}`}>{children}</div>
      </div>
    </div>,
    document.body
  )
}




