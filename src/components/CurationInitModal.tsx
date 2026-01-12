import Modal from './Modal'

export interface CurationInitStatsDisplay {
  totalPosts: number
  droppedCount: number
  followeeCount: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
  daysAnalyzed: number
  postsPerDay: number
}

interface CurationInitModalProps {
  isOpen: boolean
  onClose: () => void
  stats: CurationInitStatsDisplay | null
}

export default function CurationInitModal({ isOpen, onClose, stats }: CurationInitModalProps) {
  if (!stats) return null

  const dropPercentage = stats.totalPosts > 0
    ? Math.round((stats.droppedCount / stats.totalPosts) * 100)
    : 0

  const endTimeStr = stats.newestTimestamp
    ? new Date(stats.newestTimestamp).toLocaleString()
    : 'now'

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Curation initialized" size="sm">
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          Analyzed <strong>{stats.postsPerDay.toLocaleString()}</strong> posts/day by{' '}
          <strong>{stats.followeeCount.toLocaleString()}</strong> followee{stats.followeeCount !== 1 ? 's' : ''} over the last{' '}
          <strong>{stats.daysAnalyzed}</strong> day{stats.daysAnalyzed !== 1 ? 's' : ''} ending{' '}
          {endTimeStr}.
        </p>

        <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
          <div className="text-sm text-gray-600 dark:text-gray-400">Dropped by curation</div>
          <div className="text-3xl font-semibold text-gray-900 dark:text-gray-100">{dropPercentage}%</div>
          <div className="text-xs text-gray-500 dark:text-gray-500">
            ({stats.droppedCount.toLocaleString()} of {stats.totalPosts.toLocaleString()} posts)
          </div>
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
