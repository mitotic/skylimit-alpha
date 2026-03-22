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

  'Edition layout help':
    'Editions are curated collections of posts created at specific times of the day, using pattern matching on user handles and topics. The Edition Layout defines patterns for each edition and section.\n\nStart by adding edition times, then add user handles to the HEAD section (shared across all editions). You can import Bluesky lists. After saving, use "Re-curate recent posts" to assemble editions.',

  'Edition layout placeholder':
    '# HEAD\n@*: #BreakingNews\n@insightful.quietposter.always.show\n\n## Workplace - common section for all editions\n@coworker1\n@coworker2\n\n# 08:00 Morning Edition\n@always.interesting.bsky.social\n@sometimes.interesting: topic, second topic\n\n## Substacks in the morning\n@author1.com: blogname1.substack.com \n@author2.bsky.social: blogname2.substack.com \n\n# 12:00 Noon Edition\n## Humor\n@xkcd.com\n@phdcomics.com\n\n# 18:00 Evening Edition\n## Coding\n@simonwillison.net\n\n# TAIL\n## Catchall common section\n@author1.com',

  'about':
    'SkyLimit is a curating Bluesky client implemented as an installable web app. Use it to limit the posts viewed per day and create newspaper-like editions of curated posts.\n\nFollow @skylimit.dev to receive updates about the app.\n\nSkylimit is open-source: https://github.com/mitotic/skylimit-alpha#readme',
}

/**
 * Structured intro/help message displayed on the home page.
 * Used by both the first-time intro banner and the help (?) modal.
 * Markup conventions: _text_ for emphasis, @handle for profile links.
 */
export const introMessage = {
  header: 'Skylimit Help',
  bullets: [
    'Use _Settings/Curation_ to limit the average number of posts shown per day.',
    'Posts are numbered, starting at midnight. Click on the post number to adjust whether you want to see more (or fewer) posts from that poster.',
    'You can see posting and curation statistics for all those you follow in _Settings/Following_.',
  ],
  initWarning: 'Initializing curation by fetching recent posts will take a minute or two; stay on the home page until it completes.',
}

/** Look up a glossary term (case-insensitive). Returns undefined if not found. */
export function getGlossaryDefinition(term: string): string | undefined {
  if (helpGlossary[term]) return helpGlossary[term]
  const lower = term.toLowerCase()
  const key = Object.keys(helpGlossary).find(k => k.toLowerCase() === lower)
  return key ? helpGlossary[key] : undefined
}
