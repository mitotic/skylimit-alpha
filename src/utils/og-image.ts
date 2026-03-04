/**
 * Utility to extract OG/Twitter Card image from a URL
 */

export interface OGImageData {
  url: string
  title?: string
  description?: string
}

/**
 * Extracts the last URL from text
 */
export function extractLastUrl(text: string): string | null {
  // Require domain with at least one dot and a TLD (2+ chars) to avoid matching partial URLs
  const urlRegex = /(https?:\/\/[^\s]+\.[a-zA-Z]{2,}[^\s]*)/g
  const matches = text.match(urlRegex)
  return matches && matches.length > 0 ? matches[matches.length - 1] : null
}

/**
 * Fetches OG image from a URL using a CORS proxy
 * Note: In production, you'd want to use your own backend endpoint
 */
export async function fetchOGImage(url: string): Promise<OGImageData | null> {
  try {
    // Try multiple CORS proxies with fallback
    const encoded = encodeURIComponent(url)
    const proxies = [
      { url: `https://corsproxy.io/?url=${encoded}`, extract: (r: Response) => r.text() },
      { url: `https://api.allorigins.win/get?url=${encoded}`, extract: async (r: Response) => (await r.json()).contents },
    ]

    let html: string | null = null
    for (const proxy of proxies) {
      try {
        const response = await fetch(proxy.url)
        if (!response.ok) continue
        html = await proxy.extract(response)
        if (html) break
      } catch {
        continue
      }
    }
    if (!html) return null
    
    // Parse HTML to extract OG/Twitter Card meta tags
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    
    // Try Twitter Card first, then OG tags
    let imageUrl = 
      doc.querySelector('meta[property="twitter:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      null
    
    // If image URL is relative, make it absolute
    if (imageUrl && !imageUrl.startsWith('http')) {
      try {
        const baseUrl = new URL(url)
        imageUrl = new URL(imageUrl, baseUrl.origin).href
      } catch {
        return null
      }
    }
    
    if (!imageUrl) return null
    
    const title = 
      doc.querySelector('meta[property="twitter:title"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.querySelector('title')?.textContent ||
      undefined
    
    const description = 
      doc.querySelector('meta[property="twitter:description"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:description"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      undefined
    
    return {
      url: imageUrl,
      title,
      description,
    }
  } catch (error) {
    console.error('Failed to fetch OG image:', error)
    return null
  }
}




