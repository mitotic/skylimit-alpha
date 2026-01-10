import { BskyAgent } from '@atproto/api'

export interface Session {
  did: string
  handle: string
  email?: string
  accessJwt: string
  refreshJwt: string
}

export interface AppSession {
  session: Session
  agent: BskyAgent
}

export interface FeedPost {
  uri: string
  cid: string
  author: {
    did: string
    handle: string
    displayName?: string
    avatar?: string
    description?: string
  }
  record: {
    text: string
    createdAt: string
    embed?: {
      $type: string
      images?: Array<{
        alt: string
        image: {
          ref: {
            $link: string
          }
          mimeType: string
          size: number
        }
        aspectRatio?: {
          width: number
          height: number
        }
      }>
      record?: {
        uri: string
        cid: string
      }
      media?: {
        images?: Array<{
          alt: string
          image: {
            ref: {
              $link: string
            }
            mimeType: string
            size: number
          }
        }>
      }
    }
    reply?: {
      root: {
        uri: string
        cid: string
      }
      parent: {
        uri: string
        cid: string
      }
    }
  }
  likeCount?: number
  replyCount?: number
  repostCount?: number
  viewer?: {
    like?: string
    repost?: string
  }
  embed?: {
    $type: string
    record?: {
      record: {
        text: string
        author: {
          did: string
          handle: string
          displayName?: string
          avatar?: string
        }
        embed?: {
          images?: Array<{
            alt: string
            image: {
              ref: {
                $link: string
              }
            }
          }>
        }
      }
    }
    images?: Array<{
      alt: string
      image: {
        ref: {
          $link: string
        }
      }
    }>
  }
}

export interface Profile {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  banner?: string
  followersCount?: number
  followsCount?: number
  postsCount?: number
  viewer?: {
    following?: string
    followedBy?: string
  }
}

export interface SearchActor {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  viewer?: {
    following?: string
    followedBy?: string
  }
}

