import { useState, useCallback } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost, bookmarkPost, unbookmarkPost, deletePost } from '../api/posts'
import { pinPost } from '../api/profile'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import { updatePostSummaryEngagement } from '../curation/skylimitCache'
import { getPostUniqueId } from '../curation/skylimitGeneral'
import { ENGAGEMENT_LIKED, ENGAGEMENT_BOOKMARKED, ENGAGEMENT_REPOSTED, ENGAGEMENT_REPLIED } from '../curation/types'

interface UsePostInteractionsParams {
  agent: BskyAgent | null
  feed: AppBskyFeedDefs.FeedViewPost[]
  setFeed: React.Dispatch<React.SetStateAction<AppBskyFeedDefs.FeedViewPost[]>>
  addToast: (message: string, type: 'success' | 'error' | 'info') => void
  forceProbeRef: React.MutableRefObject<boolean>
  setForceProbeTrigger: React.Dispatch<React.SetStateAction<number>>
  myUsername?: string
}

// Resolve the cache uniqueId for a post URI by finding it in the current feed
function resolveUniqueId(feed: AppBskyFeedDefs.FeedViewPost[], uri: string): string | null {
  const post = feed.find(p => p.post.uri === uri)
  return post ? getPostUniqueId(post) : null
}

export function usePostInteractions({ agent, feed, setFeed, addToast, forceProbeRef, setForceProbeTrigger, myUsername }: UsePostInteractionsParams) {
  const [showCompose, setShowCompose] = useState(false)
  const [replyToUri, setReplyToUri] = useState<string | null>(null)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)


  const handleLike = useCallback(async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalLikeUri = post.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
    // This prevents issues if user double-clicks quickly
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            likeCount: (p.post.likeCount || 0) + (isLiked ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        // Update state to reflect unliked
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        // Update state with real like URI so unlike works
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: likeResponse.uri },
              },
            }
          }
          return p
        }))
        // Track engagement
        const uniqueId = resolveUniqueId(feed, uri)
        if (uniqueId) updatePostSummaryEngagement(uniqueId, ENGAGEMENT_LIKED, myUsername)
      }
    } catch (error) {
      // Revert optimistic count update
      setFeed(prev => prev.map(p => {
        if (p.post.uri === uri) {
          return {
            ...p,
            post: {
              ...p.post,
              likeCount: (p.post.likeCount || 0) + (isLiked ? 1 : -1),
            },
          }
        }
        return p
      }))
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }, [agent, feed, setFeed, addToast])

  const handleBookmark = useCallback(async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    const wasBookmarked = !!post.post.viewer?.bookmarked

    // Optimistic update
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            viewer: { ...p.post.viewer, bookmarked: !wasBookmarked },
          },
        }
      }
      return p
    }))

    try {
      if (wasBookmarked) {
        await unbookmarkPost(agent, uri)
      } else {
        await bookmarkPost(agent, uri, cid)
        // Track engagement
        const uniqueId = resolveUniqueId(feed, uri)
        if (uniqueId) updatePostSummaryEngagement(uniqueId, ENGAGEMENT_BOOKMARKED, myUsername)
      }
    } catch (error) {
      // Revert optimistic update
      setFeed(prev => prev.map(p => {
        if (p.post.uri === uri) {
          return {
            ...p,
            post: {
              ...p.post,
              viewer: { ...p.post.viewer, bookmarked: wasBookmarked },
            },
          }
        }
        return p
      }))
      addToast(error instanceof Error ? error.message : 'Failed to update bookmark', 'error')
    }
  }, [agent, feed, setFeed, addToast])

  const handleRepost = useCallback(async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalRepostUri = post.post.viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
    // This prevents issues if user double-clicks quickly
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            repostCount: (p.post.repostCount || 0) + (isReposted ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        // Update state to reflect unreposted
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const repostResponse = await repost(agent, uri, cid)
        // Update state with real repost URI so unrepost works
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: repostResponse.uri },
              },
            }
          }
          return p
        }))
        // Track engagement
        const uniqueId = resolveUniqueId(feed, uri)
        if (uniqueId) updatePostSummaryEngagement(uniqueId, ENGAGEMENT_REPOSTED, myUsername)
      }
    } catch (error) {
      // Revert optimistic count update
      setFeed(prev => prev.map(p => {
        if (p.post.uri === uri) {
          return {
            ...p,
            post: {
              ...p.post,
              repostCount: (p.post.repostCount || 0) + (isReposted ? 1 : -1),
            },
          }
        }
        return p
      }))
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }, [agent, feed, setFeed, addToast])

  const handleQuotePost = useCallback((post: AppBskyFeedDefs.PostView) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setQuotePost(post)
    setReplyToUri(null)
    setShowCompose(true)
  }, [addToast])

  const handleReply = useCallback((uri: string) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setReplyToUri(uri)
    setQuotePost(null)
    setShowCompose(true)
  }, [addToast])

  const handlePost = useCallback(async (
    text: string,
    replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string },
    quotePostArg?: AppBskyFeedDefs.PostView,
    images?: Array<{ image: Blob; alt: string }>,
    ogImage?: { url: string; title: string; description: string }
  ) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const buildEmbed = () => {
      if (images && images.length > 0) return { images }
      if (ogImage) return { external: { uri: ogImage.url, title: ogImage.title, description: ogImage.description, thumbUrl: ogImage.url } }
      return undefined
    }

    if (quotePostArg) {
      await createQuotePost(agent, {
        text,
        quotedPost: {
          uri: quotePostArg.uri,
          cid: quotePostArg.cid,
        },
        embed: images && images.length > 0 ? { images } : undefined,
      })
      addToast('Quote post created!', 'success')
    } else {
      await createPost(agent, {
        text,
        replyTo,
        embed: buildEmbed(),
      })
      addToast('Post created!', 'success')
      // Track reply engagement on the post being replied to
      if (replyTo) {
        const uniqueId = resolveUniqueId(feed, replyTo.uri)
        if (uniqueId) updatePostSummaryEngagement(uniqueId, ENGAGEMENT_REPLIED, myUsername)
      }
    }
    // Trigger probe to pick up the new post through paged updates
    forceProbeRef.current = true
    setForceProbeTrigger(n => n + 1)
  }, [agent, forceProbeRef, setForceProbeTrigger, addToast])

  const handlePostThread = useCallback(async (
    segments: Array<{ text: string; images: Array<{ image: Blob; alt: string }>; ogImage?: { url: string; title: string; description: string } }>,
    replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }
  ) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    let previousUri: string | undefined = replyTo?.uri
    let previousCid: string | undefined = replyTo?.cid
    let rootUri: string | undefined = replyTo?.rootUri || replyTo?.uri
    let rootCid: string | undefined = replyTo?.rootCid || replyTo?.cid

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const replyParams = previousUri && previousCid
        ? { uri: previousUri, cid: previousCid, rootUri, rootCid }
        : undefined

      const buildSegEmbed = () => {
        if (seg.images.length > 0) return { images: seg.images }
        if (seg.ogImage) return { external: { uri: seg.ogImage.url, title: seg.ogImage.title, description: seg.ogImage.description, thumbUrl: seg.ogImage.url } }
        return undefined
      }

      const result = await createPost(agent, {
        text: seg.text,
        replyTo: replyParams,
        embed: buildSegEmbed(),
      })

      // First post in a new thread (no replyTo) becomes the root
      if (i === 0 && !rootUri) {
        rootUri = result.uri
        rootCid = result.cid
      }
      previousUri = result.uri
      previousCid = result.cid
    }

    addToast(`Thread posted! (${segments.length} posts)`, 'success')
    forceProbeRef.current = true
    setForceProbeTrigger(n => n + 1)
  }, [agent, forceProbeRef, setForceProbeTrigger, addToast])

  const handleAmpChange = useCallback(async () => {
    // Amp factor changes only affect future curation probabilities.
    // The displayed feed, cached posts, and summaries are unaffected.
    // PostCard.refreshAfterAmpChange already updates the popup's local state.
  }, [])

  const handleDeletePost = useCallback(async (uri: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await deletePost(agent, uri)
      setFeed(prev => prev.filter(p => p.post.uri !== uri))
      addToast('Post deleted', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to delete post', 'error')
    }
  }, [agent, setFeed, addToast])

  const handlePinPost = useCallback(async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await pinPost(agent, uri, cid)
      addToast('Post pinned to your profile', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to pin post', 'error')
    }
  }, [agent, addToast])

  return {
    showCompose,
    setShowCompose,
    replyToUri,
    setReplyToUri,
    quotePost,
    setQuotePost,
    handleLike,
    handleBookmark,
    handleRepost,
    handleQuotePost,
    handleReply,
    handlePost,
    handlePostThread,
    handleAmpChange,
    handleDeletePost,
    handlePinPost,
  }
}
