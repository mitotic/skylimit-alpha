/**
 * HMAC-SHA256 implementation for deterministic randomization
 * Uses Web Crypto API for secure hashing
 */

/**
 * Generate HMAC-SHA256 hash
 */
async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
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
  const hex = arrayBufferToHex(hash)
  
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
  return arrayBufferToHex(hash)
}

