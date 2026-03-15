import { version as currentVersion } from '../../package.json'

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
