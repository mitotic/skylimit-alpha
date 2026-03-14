import Modal from './Modal'

export interface RecurateResultStats {
  totalEntriesRecurated: number
  displayableCount: number
  editionsAssembled: number
  oldestEntryTimestamp: number
  newestEntryTimestamp: number
}

interface RecurateResultModalProps {
  isOpen: boolean
  onClose: () => void
  stats: RecurateResultStats | null
  title?: string
  verb?: string
}

export default function RecurateResultModal({ isOpen, onClose, stats, title = 'Re-curation complete', verb = 'Re-curated' }: RecurateResultModalProps) {
  if (!stats) return null

  const droppedCount = stats.totalEntriesRecurated - stats.displayableCount
  const dropPercentage = stats.totalEntriesRecurated > 0
    ? Math.round((droppedCount / stats.totalEntriesRecurated) * 100)
    : 0

  const timeRangeHours = (stats.newestEntryTimestamp - stats.oldestEntryTimestamp) / (3600 * 1000)
  const timeDesc = timeRangeHours >= 24
    ? `${Math.round(timeRangeHours / 24 * 10) / 10} days`
    : `${Math.round(timeRangeHours)} hours`

  const startTimeStr = new Date(stats.oldestEntryTimestamp).toLocaleString()
  const endTimeStr = new Date(stats.newestEntryTimestamp).toLocaleString()

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          {verb} <strong>{stats.totalEntriesRecurated.toLocaleString()}</strong> posts
          spanning <strong>{timeDesc}</strong>, from {startTimeStr} to {endTimeStr}.
        </p>

        <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
          <div className="text-sm text-gray-600 dark:text-gray-400">Dropped by curation</div>
          <div className="text-3xl font-semibold text-gray-900 dark:text-gray-100">{dropPercentage}%</div>
          <div className="text-xs text-gray-500 dark:text-gray-500">
            ({droppedCount.toLocaleString()} of {stats.totalEntriesRecurated.toLocaleString()} posts)
          </div>
        </div>

        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>Shown: <strong>{stats.displayableCount.toLocaleString()}</strong></span>
          <span className="text-red-600 dark:text-red-400">Editions: <strong>{stats.editionsAssembled}</strong></span>
        </div>

        <button
          onClick={onClose}
          className="w-full px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Got it
        </button>
      </div>
    </Modal>
  )
}
