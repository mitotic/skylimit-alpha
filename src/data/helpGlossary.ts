/**
 * Centralized glossary of Skylimit curation terms.
 * Components can import and look up definitions for tooltips, help popups, etc.
 */

export const helpGlossary: Record<string, string> = {
  'Followee':
    'The username/handle of the account you follow.',

  'Amp factor':
    'Amplification factor that increases the probability of showing posts from prolific posters. The default value is 1.',

  'Skylimit number':
    'The number of posts per day guaranteed for the average user (amp factor value of 1).',

  'Posts':
    'The daily average number of posts from the user.',

  'Allow':
    'The number of posts that will be shown for the user per day on the average.',

  'Shown':
    'The actual number of posts shown daily from the user. This may differ from the allowed number due to statistical fluctuations.',

  'Show probability':
    'The probability that a post from the user will be shown. Priority posts will have a higher show probability than regular posts. For "quiet posters" the probability will typically be 100%.',

  'Enggd':
    'Metric of your engagement with posts from the user (daily average). Post engagement is measured as follows: 0-viewed; 1-clicked; 2-liked; 3-bookmarked; 4-reposted; 5-replied.',

  'Edited':
    'Number of posts that are displayed in Periodic Editions (instead of the home feed).',

  'Matching pattern':
    'The text pattern that is used to classify posts as priority posts or edition posts.',

  'Edition':
    'A curated collection of posts that is created at specific times of the day.',

  'Edition layout':
    'Lines starting with @ define user patterns (with optional topics after colon separated by commas). ## marks sections, # hh:mm marks timed editions. # HEAD and # TAIL mark leading/trailing sections that apply to all editions. * denotes wildcard match to word boundary. Patterns are matched top-to-bottom (first match wins).',
}

/** Look up a glossary term (case-insensitive). Returns undefined if not found. */
export function getGlossaryDefinition(term: string): string | undefined {
  if (helpGlossary[term]) return helpGlossary[term]
  const lower = term.toLowerCase()
  const key = Object.keys(helpGlossary).find(k => k.toLowerCase() === lower)
  return key ? helpGlossary[key] : undefined
}
