import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import PostCard from '../PostCard'
import { AppBskyFeedDefs } from '@atproto/api'

// Mock date-fns
vi.mock('date-fns', () => ({
  formatDistanceToNow: () => '2 hours ago',
}))

// Mock react-router-dom navigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockPost: AppBskyFeedDefs.FeedViewPost = {
  post: {
    uri: 'at://did:plc:test/app.bsky.feed.post/123',
    cid: 'test-cid',
    indexedAt: new Date().toISOString(),
    author: {
      did: 'did:plc:test',
      handle: 'test.bsky.social',
      displayName: 'Test User',
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: 'This is a test post',
      createdAt: new Date().toISOString(),
    },
    likeCount: 5,
    repostCount: 2,
    replyCount: 1,
  },
}

describe('PostCard', () => {
  it('renders post content', () => {
    render(
      <BrowserRouter>
        <PostCard post={mockPost} />
      </BrowserRouter>
    )

    expect(screen.getByText('This is a test post')).toBeInTheDocument()
    expect(screen.getByText('Test User')).toBeInTheDocument()
    expect(screen.getByText('@test.bsky.social')).toBeInTheDocument()
  })

  it('renders engagement counts', () => {
    render(
      <BrowserRouter>
        <PostCard post={mockPost} />
      </BrowserRouter>
    )

    expect(screen.getByText('1')).toBeInTheDocument() // reply count
    expect(screen.getByText('2')).toBeInTheDocument() // repost count
    expect(screen.getByText('5')).toBeInTheDocument() // like count
  })
})

