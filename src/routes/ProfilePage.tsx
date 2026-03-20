import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { AppBskyFeedDefs, AppBskyRichtextFacet, RichText as RichTextAPI } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getProfile, updateProfile } from '../api/profile'
import { getAuthorFeed, getActorLikes } from '../api/feed'
import { follow, unfollow } from '../api/social'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost, bookmarkPost, unbookmarkPost, deletePost } from '../api/posts'
import { pinPost } from '../api/profile'
import { getPostUniqueId, getProfileUrl, extractPriorityPatternsFromProfile, extractTimezone } from '../curation/skylimitGeneral'
import { clientNow } from '../utils/clientClock'
import { getFilter, getFollow, saveFollow, deleteFollow } from '../curation/skylimitCache'
import { UserEntry, FollowInfo, DEFAULT_PRIORITY_PATTERNS, GlobalStats } from '../curation/types'
import { countTotalPostsForUser } from '../curation/skylimitStats'
import { ampUp, ampDown } from '../curation/skylimitFollows'
import { getSettings } from '../curation/skylimitStore'
import { findEditionMatchesForUser, saveEditionLayout, EditionMatch, getEditionsFromLayout, findInsertionLineIndex, findEditionEndLineIndex, isValidSectionName } from '../curation/skylimitEditions'
import CurationPopup from '../components/CurationPopup'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import PostCard from '../components/PostCard'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import Modal from '../components/Modal'
import ConfirmModal from '../components/ConfirmModal'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RichText from '../components/RichText'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import log from '../utils/logger'

type Tab = 'posts' | 'replies' | 'likes'

export default function ProfilePage() {
  const { actor } = useParams<{ actor: string }>()
  const { agent, session, logout } = useSession()
  const [profile, setProfile] = useState<any>(null)
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [activeTab, setActiveTab] = useState<Tab>('posts')
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [showLogoutModal, setShowLogoutModal] = useState(false)
  const [descriptionFacets, setDescriptionFacets] = useState<AppBskyRichtextFacet.Main[] | undefined>()
  const [curationUserEntry, setCurationUserEntry] = useState<UserEntry | null>(null)
  const [curationFollowInfo, setCurationFollowInfo] = useState<FollowInfo | null>(null)
  const [curationGlobalStats, setCurationGlobalStats] = useState<GlobalStats | null>(null)
  const [showCurationPopup, setShowCurationPopup] = useState(false)
  const [ampLoading, setAmpLoading] = useState(false)
  const [curationPopupAnchorRect, setCurationPopupAnchorRect] = useState<DOMRect | null>(null)
  const [debugMode, setDebugMode] = useState(false)
  const [editionLayout, setEditionLayout] = useState('')
  const [editingPriorityPattern, setEditingPriorityPattern] = useState(false)
  const [priorityPatternDraft, setPriorityPatternDraft] = useState('')
  const [editingEditionIndex, setEditingEditionIndex] = useState<number | null>(null)
  const [editionPatternDraft, setEditionPatternDraft] = useState('')
  const [addingToEdition, setAddingToEdition] = useState(false)
  const [addEditionStep, setAddEditionStep] = useState<'edition' | 'section' | 'pattern'>('edition')
  const [selectedEditionIdx, setSelectedEditionIdx] = useState<number | null>(null)
  const [selectedSection, setSelectedSection] = useState<string | null>(null)
  const [addPatternDraft, setAddPatternDraft] = useState('')
  const [newEditionTime, setNewEditionTime] = useState('')
  const [newSectionName, setNewSectionName] = useState('')
  const [showEditProfile, setShowEditProfile] = useState(false)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editAvatarPreview, setEditAvatarPreview] = useState<string | null>(null)
  const [editAvatarFile, setEditAvatarFile] = useState<File | null>(null)
  const [editBannerPreview, setEditBannerPreview] = useState<string | null>(null)
  const [editBannerFile, setEditBannerFile] = useState<File | null>(null)
  const [editProfileSaving, setEditProfileSaving] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const isMountedRef = useRef(true)
  const currentActorRef = useRef<string | undefined>(actor)
  const changeButtonRef = useRef<HTMLButtonElement>(null)

  // Update actor ref when actor changes
  useEffect(() => {
    currentActorRef.current = actor
  }, [actor])

  // Detect facets in profile description if not provided by the API
  useEffect(() => {
    if (!profile?.description) {
      setDescriptionFacets(undefined)
      return
    }
    if (profile.descriptionFacets?.length) {
      setDescriptionFacets(profile.descriptionFacets)
      return
    }
    if (!agent) return
    // Detect facets client-side (URLs, mentions, hashtags)
    const rt = new RichTextAPI({ text: profile.description })
    rt.detectFacets(agent).then(() => {
      setDescriptionFacets(rt.facets || undefined)
    }).catch(() => {
      // Silently fail - description will render as plain text
    })
  }, [profile?.description, profile?.descriptionFacets, agent])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const loadProfile = useCallback(async () => {
    if (!agent || !actor) return

    const actorAtCallTime = actor // Capture actor at call time

    try {
      const data = await getProfile(agent, actorAtCallTime)
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setProfile(data)
      }
    } catch (error) {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        log.error('Profile', 'Failed to load profile:', error)
        addToast(error instanceof Error ? error.message : 'Failed to load profile', 'error')
      }
    } finally {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setIsLoading(false)
      }
    }
  }, [agent, actor])

  const loadFeed = useCallback(async (cursor?: string, tab: Tab = 'posts') => {
    if (!agent || !actor) return

    const actorAtCallTime = actor // Capture actor at call time

    try {
      let newFeed: AppBskyFeedDefs.FeedViewPost[] = []
      let newCursor: string | undefined

      if (tab === 'posts') {
        // Posts only - filter out replies
        const result = await getAuthorFeed(agent, actorAtCallTime, { 
          cursor, 
          limit: 25,
          filter: 'posts_no_replies'
        })
        newFeed = result.feed
        newCursor = result.cursor
      } else if (tab === 'replies') {
        // Replies only - get all posts and filter for replies
        const result = await getAuthorFeed(agent, actorAtCallTime, { cursor, limit: 50 })
        // Filter to only include posts that are replies (have a reply field in record)
        newFeed = result.feed.filter(post => {
          const record = post.post.record as any
          return record?.reply !== undefined
        })
        newCursor = result.cursor
      } else if (tab === 'likes') {
        // Liked posts
        const result = await getActorLikes(agent, actorAtCallTime, { cursor, limit: 25 })
        newFeed = result.feed
        newCursor = result.cursor
      }
      
      // Only update state if component is still mounted and actor hasn't changed
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        if (cursor) {
          setFeed(prev => [...prev, ...newFeed])
        } else {
          setFeed(newFeed)
        }
        
        setCursor(newCursor)
      }
    } catch (error) {
      // Only show error if component is still mounted and actor hasn't changed
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        // Suppress "Profiles not found" errors (common when navigating away)
        const errorMessage = error instanceof Error ? error.message : 'Failed to load feed'
        if (!errorMessage.includes('Profiles not found') && !errorMessage.includes('Profile not found')) {
          log.error('Profile', 'Failed to load feed:', error)
          addToast(errorMessage, 'error')
        }
      }
    } finally {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setIsLoadingMore(false)
      }
    }
  }, [agent, actor])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  // Load curation data when profile is available
  const loadCurationData = useCallback(async () => {
    if (!profile?.handle) return
    try {
      const username = profile.handle
      let [filterResult, followInfoResult, settings] = await Promise.all([
        getFilter(),
        getFollow(username),
        getSettings()
      ])
      if (!isMountedRef.current) return
      if (filterResult) {
        const [globalStats, userFilter] = filterResult
        setCurationGlobalStats(globalStats)
        setCurationUserEntry(userFilter[username] || null)
      } else {
        setCurationGlobalStats(null)
        setCurationUserEntry(null)
      }
      // Update cached follow entry with fresh profile data
      if (followInfoResult && profile) {
        const liveFollowedBy = !!profile.viewer?.followedBy
        const liveDisplayName = profile.displayName || undefined
        const livePatterns = extractPriorityPatternsFromProfile(profile) || followInfoResult.priorityPatterns
        const liveTimezone = extractTimezone(profile)
        if (
          followInfoResult.followedBy !== liveFollowedBy ||
          followInfoResult.displayName !== liveDisplayName ||
          (livePatterns && followInfoResult.priorityPatterns !== livePatterns) ||
          (liveTimezone !== 'UTC' && followInfoResult.timezone !== liveTimezone)
        ) {
          const updated = {
            ...followInfoResult,
            followedBy: liveFollowedBy,
            displayName: liveDisplayName,
            ...(livePatterns && { priorityPatterns: livePatterns }),
            ...(liveTimezone !== 'UTC' && { timezone: liveTimezone }),
            lastUpdatedAt: clientNow(),
          }
          await saveFollow(updated)
          followInfoResult = updated
        }
      }
      setCurationFollowInfo(followInfoResult)
      setEditionLayout(settings?.editionLayout || '')
      setDebugMode(settings?.debugMode || false)
    } catch (error) {
      log.error('Profile', 'Failed to load curation data:', error)
    }
  }, [profile?.handle])

  useEffect(() => {
    loadCurationData()
  }, [loadCurationData])

  useEffect(() => {
    setFeed([])
    setCursor(undefined)
    setIsLoadingMore(true)
    loadFeed(undefined, activeTab)
  }, [activeTab, loadFeed])

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const handleFollow = async () => {
    if (!agent || !profile) return
    if (isReadOnlyMode()) {
      addToast('Disable Read-only mode in Settings to do this', 'error')
      return
    }

    const previousViewer = profile.viewer
    try {
      if (profile.viewer?.following) {
        // Optimistic update before API call
        setProfile((prev: any) => prev ? {
          ...prev,
          viewer: { ...prev.viewer, following: undefined }
        } : prev)
        await unfollow(agent, profile.viewer.following)
        await deleteFollow(profile.handle)
        addToast('Unfollowed', 'success')
      } else {
        // Optimistic update before API call
        setProfile((prev: any) => prev ? {
          ...prev,
          viewer: { ...prev.viewer, following: 'pending' }
        } : prev)
        const result = await follow(agent, profile.did)
        // Update with real URI from server
        setProfile((prev: any) => prev ? {
          ...prev,
          viewer: { ...prev.viewer, following: result.uri }
        } : prev)
        const priorityPatterns = extractPriorityPatternsFromProfile(profile)
        const timezone = extractTimezone(profile)
        await saveFollow({
          username: profile.handle,
          accountDid: profile.did,
          displayName: profile.displayName || undefined,
          followed_at: new Date().toISOString(),
          amp_factor: 1,
          priorityPatterns: priorityPatterns || undefined,
          timezone,
          followedBy: !!profile.viewer?.followedBy,
          lastUpdatedAt: clientNow(),
        })
        addToast('Following', 'success')
      }
      loadCurationData()
    } catch (error) {
      // Revert optimistic update on failure
      setProfile((prev: any) => prev ? {
        ...prev,
        viewer: previousViewer
      } : prev)
      addToast(error instanceof Error ? error.message : 'Failed to update follow status', 'error')
    }
  }

  const handleLike = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalLikeUri = post.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
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
      }
    } catch (error) {
      loadFeed(undefined, activeTab)
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleBookmark = async (uri: string, cid: string) => {
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
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalRepostUri = post.post.viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
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
      }
    } catch (error) {
      loadFeed(undefined, activeTab)
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setQuotePost(post)
    setShowCompose(true)
  }

  const handlePost = async (text: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    if (quotePost) {
      await createQuotePost(agent, {
        text,
        quotedPost: {
          uri: quotePost.uri,
          cid: quotePost.cid,
        },
      })
      addToast('Quote post created!', 'success')
    } else {
      await createPost(agent, { text })
      addToast('Post created!', 'success')
    }
    loadFeed(undefined, activeTab)
  }

  const handleDeletePost = async (uri: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await deletePost(agent, uri)
      setFeed(prev => prev.filter(p => p.post.uri !== uri))
      addToast('Post deleted', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to delete post', 'error')
    }
  }

  const handlePinPost = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await pinPost(agent, uri, cid)
      addToast('Post pinned to your profile', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to pin post', 'error')
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>Profile not found</p>
      </div>
    )
  }

  const isOwnProfile = session?.handle === profile.handle

  const formatCount = (count: number): string => {
    if (count < 10) return count.toFixed(1)
    return Math.round(count).toString()
  }

  const handleCurationAmpUp = async () => {
    if (!profile?.handle || !session?.handle) return
    try {
      setAmpLoading(true)
      await ampUp(profile.handle, session.handle)
      await loadCurationData()
    } catch (error) {
      log.error('Profile', 'Failed to amp up:', error)
    } finally {
      setAmpLoading(false)
    }
  }

  const handleCurationAmpDown = async () => {
    if (!profile?.handle || !session?.handle) return
    try {
      setAmpLoading(true)
      await ampDown(profile.handle, session.handle)
      await loadCurationData()
    } catch (error) {
      log.error('Profile', 'Failed to amp down:', error)
    } finally {
      setAmpLoading(false)
    }
  }

  const handleSavePriorityPattern = async () => {
    if (!curationFollowInfo || !profile?.handle) return
    try {
      const updated = { ...curationFollowInfo, priorityPatterns: priorityPatternDraft.trim() }
      await saveFollow(updated)
      setEditingPriorityPattern(false)
      await loadCurationData()
    } catch (error) {
      log.error('Profile', 'Failed to save priority pattern:', error)
    }
  }

  const handleSaveEditionPattern = async (match: EditionMatch) => {
    if (!profile?.handle) return
    try {
      const lines = editionLayout.split('\n')
      const newPatterns = editionPatternDraft.trim()
      lines[match.lineIndex] = newPatterns ? `@${profile.handle}: ${newPatterns}` : `@${profile.handle}`
      const result = await saveEditionLayout(lines.join('\n'))
      if (!result.success) {
        alert('Edition layout validation failed:\n' + result.errors.join('\n'))
        return
      }
      setEditingEditionIndex(null)
      await loadCurationData()
    } catch (error) {
      log.error('Profile', 'Failed to save edition pattern:', error)
    }
  }

  const handleRemoveEditionLine = async (match: EditionMatch) => {
    try {
      const lines = editionLayout.split('\n')
      lines.splice(match.lineIndex, 1)

      // Check if the section is now empty (no @pattern lines) and remove the ## header if so
      if (match.sectionName !== '(default)') {
        // Find the section header for this match by scanning backwards from the removed line
        let sectionHeaderIdx = -1
        for (let i = match.lineIndex - 1; i >= 0; i--) {
          const trimmed = lines[i]?.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('## ')) {
            const secName = trimmed.substring(3).trim()
            if (secName === match.sectionName) sectionHeaderIdx = i
            break
          }
          if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) break
        }
        if (sectionHeaderIdx >= 0) {
          // Check if there are any @pattern lines remaining in this section
          let hasPatterns = false
          for (let i = sectionHeaderIdx + 1; i < lines.length; i++) {
            const trimmed = lines[i]?.trim()
            if (!trimmed) continue
            if (trimmed.startsWith('#')) break // next section or edition header
            if (trimmed.startsWith('@')) { hasPatterns = true; break }
          }
          if (!hasPatterns) {
            lines.splice(sectionHeaderIdx, 1)
          }
        }
      }

      const remaining = lines.join('\n')

      // Check if removing this line leaves no pattern lines — would clear the entire layout
      const hasPatterns = lines.some(l => l.trim().startsWith('@'))
      let layoutToSave = remaining
      if (!hasPatterns) {
        if (!confirm('Removing this entry will clear the entire Edition Layout. Proceed?')) {
          return
        }
        layoutToSave = ''
      }

      const result = await saveEditionLayout(layoutToSave)
      if (!result.success) {
        alert('Edition layout validation failed:\n' + result.errors.join('\n'))
        return
      }
      await loadCurationData()
    } catch (error) {
      log.error('Profile', 'Failed to remove edition line:', error)
    }
  }

  const openEditProfile = () => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    if (!profile) return
    setEditDisplayName(profile.displayName || '')
    setEditDescription(profile.description || '')
    setEditAvatarPreview(profile.avatar || null)
    setEditAvatarFile(null)
    setEditBannerPreview(profile.banner || null)
    setEditBannerFile(null)
    setShowEditProfile(true)
  }

  const closeEditProfile = () => {
    // Clean up object URLs
    if (editAvatarFile && editAvatarPreview) URL.revokeObjectURL(editAvatarPreview)
    if (editBannerFile && editBannerPreview) URL.revokeObjectURL(editBannerPreview)
    setShowEditProfile(false)
  }

  const handleImageSelect = (file: File, type: 'avatar' | 'banner') => {
    if (!file.type.startsWith('image/')) {
      addToast('Please select an image file', 'error')
      return
    }
    if (file.size > 1 * 1024 * 1024) {
      addToast('Image must be under 1MB', 'error')
      return
    }
    const preview = URL.createObjectURL(file)
    if (type === 'avatar') {
      if (editAvatarFile && editAvatarPreview) URL.revokeObjectURL(editAvatarPreview)
      setEditAvatarFile(file)
      setEditAvatarPreview(preview)
    } else {
      if (editBannerFile && editBannerPreview) URL.revokeObjectURL(editBannerPreview)
      setEditBannerFile(file)
      setEditBannerPreview(preview)
    }
  }

  const handleSaveProfile = async () => {
    if (!agent || editProfileSaving) return
    setEditProfileSaving(true)
    try {
      await updateProfile(agent, {
        displayName: editDisplayName,
        description: editDescription.slice(0, 256),
        ...(editAvatarFile ? { avatar: editAvatarFile } : {}),
        ...(editBannerFile ? { banner: editBannerFile } : {}),
      })
      closeEditProfile()
      addToast('Profile updated', 'success')
      // Reload profile
      if (profile?.handle) {
        const updated = await getProfile(agent, profile.handle)
        setProfile(updated)
      }
    } catch (error) {
      log.error('Profile', 'Failed to update profile:', error)
      addToast(error instanceof Error ? error.message : 'Failed to update profile', 'error')
    } finally {
      setEditProfileSaving(false)
    }
  }

  // Compute curation display values
  const priorityPatterns = curationFollowInfo?.priorityPatterns || curationUserEntry?.priorityPatterns
  const hasPriority = curationUserEntry ? (
    (priorityPatterns !== undefined && priorityPatterns !== '' && priorityPatterns !== DEFAULT_PRIORITY_PATTERNS) ||
    (curationUserEntry.priority_daily > 0)
  ) : false
  const editionMatches = profile?.handle ? findEditionMatchesForUser(editionLayout, profile.handle) : []
  const layoutEditions = getEditionsFromLayout(editionLayout)

  // Time options for empty-layout case (same 30-min intervals as EditionLayoutEditor)
  const TIME_OPTIONS: string[] = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }

  const resetAddEditionState = () => {
    setAddingToEdition(false)
    setAddEditionStep('edition')
    setSelectedEditionIdx(null)
    setSelectedSection(null)
    setAddPatternDraft('')
    setNewEditionTime('')
    setNewSectionName('')
  }

  const handleAddEditionPattern = async () => {
    if (!profile?.handle) return
    const patternLine = addPatternDraft.trim()
      ? `@${profile.handle}: ${addPatternDraft.trim()}`
      : `@${profile.handle}`

    let newLayout: string

    if (layoutEditions.length === 0 && newEditionTime) {
      // Empty layout — create new edition
      newLayout = `# ${newEditionTime}\n${patternLine}`
    } else if (selectedEditionIdx !== null && selectedSection === '__new__') {
      // Creating a new section
      const sectionName = newSectionName.trim()
      if (!sectionName) {
        alert('Please enter a section name.')
        return
      }
      if (!isValidSectionName(sectionName)) {
        alert('Invalid section name. Use letters, numbers, spaces, and hyphens. Must start and end with a letter or number.')
        return
      }
      const edition = layoutEditions[selectedEditionIdx]
      if (edition.sectionNames.includes(sectionName)) {
        alert(`Section "${sectionName}" already exists in this edition.`)
        return
      }
      const endLine = findEditionEndLineIndex(
        editionLayout,
        edition.editionTime,
        edition.isHead,
        edition.isTail
      )
      const lines = editionLayout.split('\n')
      const newLines = [`## ${sectionName}`, patternLine]
      if (endLine === -1) {
        lines.unshift(...newLines)
      } else {
        lines.splice(endLine + 1, 0, ...newLines)
      }
      newLayout = lines.join('\n')
    } else if (selectedEditionIdx !== null && selectedSection !== null) {
      // Adding to existing section
      const edition = layoutEditions[selectedEditionIdx]
      const insertAfter = findInsertionLineIndex(
        editionLayout,
        edition.editionTime,
        edition.isHead,
        edition.isTail,
        selectedSection
      )
      const lines = editionLayout.split('\n')
      if (insertAfter === -1) {
        lines.unshift(patternLine)
      } else {
        lines.splice(insertAfter + 1, 0, patternLine)
      }
      newLayout = lines.join('\n')
    } else {
      return
    }

    const result = await saveEditionLayout(newLayout)
    if (result.success) {
      resetAddEditionState()
      loadCurationData()
    } else {
      alert('Edition layout validation failed:\n' + result.errors.join('\n'))
    }
  }

  return (
    <div className="pb-20 md:pb-0">
      {/* Profile Header */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        {profile.banner && (
          <div
            className="h-48 bg-cover bg-center"
            style={{ backgroundImage: `url(${profile.banner})` }}
          />
        )}
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-end gap-4 -mt-16">
              <Avatar
                src={profile.avatar}
                alt={profile.displayName || profile.handle}
                size="lg"
                className="border-4 border-white dark:border-gray-900"
              />
            </div>
            {isOwnProfile ? (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={openEditProfile}
                >
                  Edit Profile
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setShowLogoutModal(true)}
                >
                  Logout
                </Button>
              </div>
            ) : (
              <Button
                variant={profile.viewer?.following ? "secondary" : "primary"}
                onClick={handleFollow}
                className={isReadOnlyMode() ? 'opacity-50 cursor-not-allowed' : ''}
              >
                {profile.viewer?.following ? 'Unfollow' : 'Follow'}
              </Button>
            )}
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold">{profile.displayName || profile.handle}</h1>
              <a
                href={getProfileUrl(profile.handle)}
                className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
              >
                View on Bluesky ↗
              </a>
            </div>
            <p className="text-gray-500 dark:text-gray-400">
              @{profile.handle}
              {profile.viewer?.followedBy && (
                <span className="ml-2 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5">Follows you</span>
              )}
            </p>
            {profile.description && (
              <div className="mt-2 whitespace-pre-wrap">
                <RichText text={profile.description} facets={descriptionFacets} />
              </div>
            )}
            <div className="flex gap-4 mt-4 text-sm text-gray-500 dark:text-gray-400">
              <Link to={`/profile/${profile.handle}/following`} className="text-blue-500 dark:text-blue-400 hover:underline hover:text-blue-600 dark:hover:text-blue-300">{profile.followsCount || 0} Following</Link>
              <Link to={`/profile/${profile.handle}/followers`} className="text-blue-500 dark:text-blue-400 hover:underline hover:text-blue-600 dark:hover:text-blue-300">{profile.followersCount || 0} Followers</Link>
              <span>{profile.postsCount || 0} Posts</span>
            </div>
          </div>
        </div>
      </div>

      {/* Curation Info */}
      {(curationUserEntry || curationFollowInfo) && (() => {
        const postingPerDay = curationUserEntry ? countTotalPostsForUser(curationUserEntry) : 0
        const regularPerDay = curationUserEntry && hasPriority ? postingPerDay - curationUserEntry.priority_daily : postingPerDay
        return (
          <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-2">
            <div className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-1">Curation Info</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
              {curationUserEntry && (
                <div><span className="font-semibold">Posts/day:</span> {formatCount(regularPerDay)} regular{hasPriority ? `, ${formatCount(curationUserEntry.priority_daily)} priority` : ''}, {formatCount(curationUserEntry.edited_daily)} edited</div>
              )}
              {isOwnProfile && (
                <div>
                  <span className="font-semibold">Priority topics:</span>{' '}
                  <span className="text-gray-500 dark:text-gray-400">{extractPriorityPatternsFromProfile(profile) || priorityPatterns || '(all hashtags)'}</span>
                </div>
              )}
              {!isOwnProfile && (
                <>
                  {curationUserEntry && (
                    <div><span className="font-semibold">Show probability:</span> <span className={curationUserEntry.regular_prob >= 1.0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{(curationUserEntry.regular_prob * 100).toFixed(1)}%</span> regular{hasPriority ? <>, <span className={curationUserEntry.priority_prob >= 1.0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{(curationUserEntry.priority_prob * 100).toFixed(1)}%</span> priority</> : ''}</div>
                  )}
                  {curationUserEntry && curationUserEntry.medianPop > 0 && (
                    <div><span className="font-semibold">Median Popularity Index:</span> {curationUserEntry.medianPop}</div>
                  )}
                  {curationUserEntry && (
                    <div>
                      <span className="font-semibold">Amplification factor:</span> {(curationFollowInfo?.amp_factor ?? curationUserEntry.amp_factor) < 1 ? (curationFollowInfo?.amp_factor ?? curationUserEntry.amp_factor).toFixed(2) : (curationFollowInfo?.amp_factor ?? curationUserEntry.amp_factor).toFixed(1)}{' '}
                      <button
                        ref={changeButtonRef}
                        onClick={() => {
                          if (changeButtonRef.current) {
                            setCurationPopupAnchorRect(changeButtonRef.current.getBoundingClientRect())
                          }
                          setShowCurationPopup(true)
                        }}
                        className="ml-1 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                      >
                        Change
                      </button>
                      {showCurationPopup && (
                        <CurationPopup
                          displayName={profile.displayName || ''}
                          handle={profile.handle}
                          popupPosition="below"
                          anchorRect={curationPopupAnchorRect || undefined}
                          postingPerDay={Math.round(postingPerDay)}
                          originalsPerDay={curationUserEntry.original_daily}
                          priorityPerDay={curationUserEntry.priority_daily}
                          repostsPerDay={curationUserEntry.reposts_daily}
                          followedRepliesPerDay={curationUserEntry.followed_reply_daily}
                          unfollowedRepliesPerDay={curationUserEntry.unfollowed_reply_daily}
                          editedPerDay={curationUserEntry.edited_daily}
                          regularProb={curationUserEntry.regular_prob}
                          priorityProb={curationUserEntry.priority_prob}
                          skylimitNumber={curationGlobalStats?.skylimit_number}
                          showAmpButtons={true}
                          ampFactor={curationFollowInfo?.amp_factor ?? curationUserEntry.amp_factor}
                          onAmpUp={handleCurationAmpUp}
                          onAmpDown={handleCurationAmpDown}
                          ampLoading={ampLoading}
                          debugMode={debugMode}
                          followedAt={curationFollowInfo?.followed_at}
                          priorityPatterns={priorityPatterns}
                          timezone={curationFollowInfo?.timezone}
                          onClose={() => setShowCurationPopup(false)}
                        />
                      )}
                    </div>
                  )}
                  <div className="mt-2">
                    <div>
                      <span className="font-semibold">Priority topics:</span>{' '}
                      {editingPriorityPattern ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="text"
                            value={priorityPatternDraft}
                            onChange={(e) => setPriorityPatternDraft(e.target.value)}
                            className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                            size={20}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSavePriorityPattern()
                              if (e.key === 'Escape') setEditingPriorityPattern(false)
                            }}
                          />
                          <button
                            onClick={handleSavePriorityPattern}
                            className="px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingPriorityPattern(false)}
                            className="px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="text-gray-500 dark:text-gray-400">{priorityPatterns || '(all hashtags)'}</span>
                          <button
                            onClick={() => {
                              setPriorityPatternDraft(priorityPatterns || '')
                              setEditingPriorityPattern(true)
                            }}
                            className="ml-1 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                          >
                            Edit
                          </button>
                        </>
                      )}
                    </div>
                    <div className="mt-1">
                      <span className="font-semibold">Editions/Sections:</span>
                      {editionMatches.length > 0 && (
                        <>
                        {editionMatches.map((match, idx) => (
                          <div key={idx} className="ml-4">
                            {editingEditionIndex === idx ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="text-gray-500 dark:text-gray-400">{match.editionName}/{match.sectionName}:</span>
                                <input
                                  type="text"
                                  value={editionPatternDraft}
                                  onChange={(e) => setEditionPatternDraft(e.target.value)}
                                  className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                  size={20}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveEditionPattern(match)
                                    if (e.key === 'Escape') setEditingEditionIndex(null)
                                  }}
                                />
                                <button
                                  onClick={() => handleSaveEditionPattern(match)}
                                  className="px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingEditionIndex(null)}
                                  className="px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                                >
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <>
                                <span className="text-gray-500 dark:text-gray-400">{match.editionName}/{match.sectionName}:</span>{' '}
                                <span>{match.textPatterns || '(all posts)'}</span>
                                <button
                                  onClick={() => {
                                    setEditionPatternDraft(match.textPatterns)
                                    setEditingEditionIndex(idx)
                                  }}
                                  className="ml-1 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleRemoveEditionLine(match)}
                                  className="ml-1 px-2 py-0.5 text-xs text-red-600 dark:text-red-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                        </>
                      )}
                    {/* Add to Edition UI */}
                      <div className="ml-4">
                      {!addingToEdition ? (
                        <button
                          onClick={() => { resetAddEditionState(); setAddingToEdition(true) }}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Add <span className="font-semibold">@{profile.handle}</span> to an Edition
                        </button>
                      ) : layoutEditions.length === 0 ? (
                        /* Empty layout — pick time then pattern */
                        <span className="inline-flex items-center gap-1 flex-wrap">
                          <span className="text-gray-500 dark:text-gray-400 text-sm">Edition time:</span>
                          <select
                            value={newEditionTime}
                            onChange={(e) => { setNewEditionTime(e.target.value); if (e.target.value) setAddEditionStep('pattern') }}
                            className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          >
                            <option value="">--:--</option>
                            {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          {newEditionTime && (
                            <>
                              <input
                                type="text"
                                value={addPatternDraft}
                                onChange={(e) => setAddPatternDraft(e.target.value)}
                                placeholder="text patterns (optional)"
                                className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                size={20}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddEditionPattern()
                                  if (e.key === 'Escape') resetAddEditionState()
                                }}
                              />
                              <button
                                onClick={handleAddEditionPattern}
                                className="px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                              >
                                Save
                              </button>
                            </>
                          )}
                          <button
                            onClick={resetAddEditionState}
                            className="px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        /* Layout has editions — progressive dropdowns: edition / section */
                        <span className="inline-flex items-center gap-1 flex-wrap">
                          <select
                            value={selectedEditionIdx !== null ? String(selectedEditionIdx) : ''}
                            onChange={(e) => {
                              const idx = e.target.value ? Number(e.target.value) : null
                              setSelectedEditionIdx(idx)
                              setSelectedSection(null)
                              setAddPatternDraft('')
                              if (idx !== null) {
                                setAddEditionStep('section')
                              } else {
                                setAddEditionStep('edition')
                              }
                            }}
                            className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          >
                            <option value="">Select edition...</option>
                            {layoutEditions.map((ed, idx) => (
                              <option key={idx} value={String(idx)}>{ed.editionName}</option>
                            ))}
                          </select>
                          {selectedEditionIdx !== null && addEditionStep !== 'edition' && (
                            <>
                              <span className="text-gray-900 dark:text-gray-100">/</span>
                              <select
                                value={selectedSection || ''}
                                onChange={(e) => {
                                  const sec = e.target.value || null
                                  setSelectedSection(sec)
                                  setAddPatternDraft('')
                                  setNewSectionName('')
                                  if (sec) setAddEditionStep('pattern')
                                }}
                                className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                              >
                                <option value="">Select section...</option>
                                {layoutEditions[selectedEditionIdx].sectionNames.map(sec => (
                                  <option key={sec} value={sec}>{sec}</option>
                                ))}
                                <option disabled>──────────</option>
                                <option value="__new__">New section...</option>
                              </select>
                            </>
                          )}
                          {addEditionStep === 'pattern' && selectedSection !== null && (
                            <>
                              {selectedSection === '__new__' && (
                                <input
                                  type="text"
                                  value={newSectionName}
                                  onChange={(e) => setNewSectionName(e.target.value)}
                                  placeholder="Section name"
                                  className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                  size={12}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') resetAddEditionState()
                                  }}
                                />
                              )}
                              <input
                                type="text"
                                value={addPatternDraft}
                                onChange={(e) => setAddPatternDraft(e.target.value)}
                                placeholder="text patterns (optional)"
                                className="px-1 py-0.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                size={20}
                                autoFocus={selectedSection !== '__new__'}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddEditionPattern()
                                  if (e.key === 'Escape') resetAddEditionState()
                                }}
                              />
                              <button
                                onClick={handleAddEditionPattern}
                                className="px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                              >
                                Save
                              </button>
                            </>
                          )}
                          <button
                            onClick={resetAddEditionState}
                            className="px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </span>
                      )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['posts', 'replies', 'likes'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-4 py-3 text-center font-medium capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-500'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Feed */}
      <div>
        {isLoadingMore && feed.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : feed.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>
              {activeTab === 'posts' && 'No posts to show'}
              {activeTab === 'replies' && 'No replies to show'}
              {activeTab === 'likes' && 'No liked posts to show'}
            </p>
          </div>
        ) : (
          <>
            {feed.map((post) => (
              <PostCard
                key={getPostUniqueId(post)}
                post={post}
                onRepost={handleRepost}
                onQuotePost={handleQuotePost}
                onLike={handleLike}
                onBookmark={handleBookmark}
                onDeletePost={handleDeletePost}
                onPinPost={handlePinPost}
                showRootPost={false}
              />
            ))}

            {cursor && (
              <div className="p-4 text-center">
                <button
                  onClick={() => {
                    setIsLoadingMore(true)
                    loadFeed(cursor, activeTab)
                  }}
                  disabled={isLoadingMore}
                  className="btn btn-secondary"
                >
                  {isLoadingMore ? (
                    <span className="flex items-center gap-2">
                      <Spinner size="sm" />
                      Loading...
                    </span>
                  ) : (
                    'Load More'
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <Compose
        isOpen={showCompose}
        onClose={() => {
          setShowCompose(false)
          setQuotePost(null)
        }}
        quotePost={quotePost || undefined}
        onPost={handlePost}
      />

      <ConfirmModal
        isOpen={showLogoutModal}
        onClose={() => setShowLogoutModal(false)}
        onConfirm={logout}
        title="Logout"
        message="Are you sure you want to logout?"
      />

      {/* Edit Profile Modal */}
      <Modal isOpen={showEditProfile} onClose={closeEditProfile} title="Edit Profile" size="lg">
        <div className="space-y-4">
          {/* Banner */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Banner</label>
            <div
              className="relative w-full h-32 bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => bannerInputRef.current?.click()}
            >
              {editBannerPreview ? (
                <img src={editBannerPreview} alt="Banner" className="w-full h-full object-cover" />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500">
                  Click to upload banner
                </div>
              )}
            </div>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleImageSelect(e.target.files[0], 'banner')}
            />
          </div>

          {/* Avatar */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Avatar</label>
            <div
              className="relative w-20 h-20 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => avatarInputRef.current?.click()}
            >
              {editAvatarPreview ? (
                <img src={editAvatarPreview} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-xs">
                  Upload
                </div>
              )}
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleImageSelect(e.target.files[0], 'avatar')}
            />
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Name</label>
            <input
              type="text"
              value={editDisplayName}
              onChange={(e) => setEditDisplayName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              maxLength={64}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description ({editDescription.length}/256)
            </label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value.slice(0, 256))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
              rows={4}
              maxLength={256}
            />
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={closeEditProfile}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveProfile}
              disabled={editProfileSaving}
            >
              {editProfileSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}

