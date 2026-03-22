import { version as currentVersion } from '../../package.json'

export { currentVersion }

const SKYLIMIT_VERSION_KEY = 'skylimitVersion'
const RELEASE_DISMISSED_KEY = 'skylimit_release_dismissed'

/**
 * Fetch the deployed version.json (cache-busted) and compare with the running version.
 * Returns the new version string if an update is available, null otherwise.
 * Returns null on any fetch error (fail-safe: don't show update on network issues).
 */
export async function checkForAppUpdate(): Promise<string | null> {
  try {
    const resp = await fetch(`/version.json?t=${Date.now()}`)
    if (!resp.ok) return null
    const data = await resp.json()
    if (data.version && data.version !== currentVersion) {
      return data.version
    }
    return null
  } catch {
    return null
  }
}

/**
 * Check if the running code version differs from the stored version.
 * On first run (no stored version), stores the current version and returns false.
 * On version change, updates stored version and returns true.
 */
export function checkForVersionChange(): boolean {
  const stored = localStorage.getItem(SKYLIMIT_VERSION_KEY)

  if (stored === null) {
    localStorage.setItem(SKYLIMIT_VERSION_KEY, currentVersion)
    return false
  }

  if (stored === currentVersion) {
    return false
  }

  localStorage.setItem(SKYLIMIT_VERSION_KEY, currentVersion)
  return true
}

export function isReleaseDismissed(): boolean {
  return localStorage.getItem(RELEASE_DISMISSED_KEY) === currentVersion
}

export function dismissRelease(): void {
  localStorage.setItem(RELEASE_DISMISSED_KEY, currentVersion)
}

export interface ReleaseNotes {
  version: string
  message: string
}

/**
 * Fetch release notes from public/release-notes.json.
 * Returns null if fetch fails or version in file doesn't match current version.
 */
export async function fetchReleaseNotes(): Promise<ReleaseNotes | null> {
  try {
    const resp = await fetch(`/release-notes.json?t=${Date.now()}`)
    if (!resp.ok) return null
    const data: ReleaseNotes = await resp.json()
    if (data.version !== currentVersion) return null
    return data
  } catch {
    return null
  }
}
