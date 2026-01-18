/**
 * HMAC-SHA256 implementation for deterministic randomization
 * Uses Web Crypto API for secure hashing, with fallback for non-secure contexts
 */

// Check if crypto.subtle is available (only in secure contexts: HTTPS or localhost)
const isSecureContext = typeof crypto !== 'undefined' && crypto.subtle !== undefined

/**
 * Simple fallback hash for non-secure contexts (HTTP on non-localhost)
 * This is NOT cryptographically secure, but sufficient for deterministic randomization
 */
function fallbackHash(key: string, message: string): string {
  const combined = key + '|' + message
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i)
    h1 = Math.imul(h1 ^ char, 2654435761)
    h2 = Math.imul(h2 ^ char, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  // Return 64-bit hash as 16 hex characters
  const result = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
  return result
}

/**
 * Generate HMAC-SHA256 hash (or fallback hash in non-secure contexts)
 */
async function hmacSha256(key: string, message: string): Promise<ArrayBuffer | string> {
  // Use fallback in non-secure contexts (HTTP on non-localhost)
  if (!isSecureContext) {
    return fallbackHash(key, message)
  }

  const encoder = new TextEncoder()
  const keyData = encoder.encode(key)
  const messageData = encoder.encode(message)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  return crypto.subtle.sign('HMAC', cryptoKey, messageData)
}

/**
 * Convert ArrayBuffer to hex string
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate deterministic random number between 0 and 1
 * Uses HMAC-SHA256 of (secretKey + input) to ensure consistency
 */
export async function hmacRandom(secretKey: string, input: string): Promise<number> {
  const hash = await hmacSha256(secretKey, input)

  // Handle both ArrayBuffer (crypto.subtle) and string (fallback) results
  const hex = typeof hash === 'string' ? hash : arrayBufferToHex(hash)

  // Use first 8 hex characters (32 bits) to generate a number between 0 and 1
  const hexPart = hex.substring(0, 8)
  const num = parseInt(hexPart, 16)
  return num / 0xffffffff
}

/**
 * Generate hex string from HMAC (for anonymization)
 */
export async function hmacHex(secretKey: string, input: string): Promise<string> {
  const hash = await hmacSha256(secretKey, input)

  // Handle both ArrayBuffer (crypto.subtle) and string (fallback) results
  return typeof hash === 'string' ? hash : arrayBufferToHex(hash)
}

