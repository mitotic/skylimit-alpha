import { createContext, useContext, useState, ReactNode } from 'react'
import { RateLimitStatus } from '../components/RateLimitIndicator'

interface RateLimitContextType {
  rateLimitStatus: RateLimitStatus | null
  setRateLimitStatus: (status: RateLimitStatus | null) => void
}

const RateLimitContext = createContext<RateLimitContextType | undefined>(undefined)

export function RateLimitProvider({ children }: { children: ReactNode }) {
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus | null>(null)

  return (
    <RateLimitContext.Provider value={{ rateLimitStatus, setRateLimitStatus }}>
      {children}
    </RateLimitContext.Provider>
  )
}

export function useRateLimit() {
  const context = useContext(RateLimitContext)
  if (context === undefined) {
    throw new Error('useRateLimit must be used within a RateLimitProvider')
  }
  return context
}

