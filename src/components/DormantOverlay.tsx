/**
 * Overlay shown when this tab is blocked or dormant due to another
 * active Websky tab.
 *
 * - "blocked" mode: full-page message (app never mounted in this tab)
 * - "dormant" mode: translucent overlay over the frozen feed
 */

interface DormantOverlayProps {
  mode: 'blocked' | 'dormant'
  onAction: () => void
}

export default function DormantOverlay({ mode, onAction }: DormantOverlayProps) {
  if (mode === 'blocked') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 max-w-sm text-center">
          <img
            src="/SkylimitLogo.png"
            alt="Skylimit"
            className="h-16 w-16 object-contain mx-auto mb-4"
          />
          <p className="text-gray-700 dark:text-gray-300 mb-6">
            Websky is already open in another tab.
          </p>
          <button
            onClick={onAction}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium"
          >
            Use this tab instead
          </button>
        </div>
      </div>
    )
  }

  // dormant mode — overlay on top of frozen content
  return (
    <div className="fixed inset-0 z-[100] bg-black/30 flex flex-col items-center pt-20">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 mx-4 max-w-sm text-center">
        <p className="text-gray-700 dark:text-gray-300 mb-4">
          This tab is no longer active.
        </p>
        <button
          onClick={onAction}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium"
        >
          Reactivate
        </button>
      </div>
    </div>
  )
}
