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
    'An edition is a curated collections of posts that are created at specific times of the day. It\'s like a combination of Bluesky lists and feeds, but segmented in time and restricted to posts from followees only. Pattern matching is used to curate which posts to move from the main feed to an edition. A pattern is an userhandle and/or a list of topics (comma-separated). There can be multiple editions per day. Each edition has a default (unnamed) section whose posts are always visible and can have zero or more named sections.\n\nThe Edition Layout contains a list of patterns for each edition/section. Patterns are matched from top to bottom. There can be a HEAD part in the Layout with patterns and sections that are shared by all editions.\n\nFor starters, experiment with adding one or more editions by selecting their creation times. Then, add a userhandle or two to the default (unnamed) section of the HEAD part and add a named section to the HEAD with a few userhandles. You can also import your Bluesky lists into the Edition Layout. The HEAD entries will appear in all editions. (Later, you can add edition-specific patterns/sections and also add a TAIL part for catchall patterns/sections.) After you save the Edition/Layout, you can use the "Re-curate recent posts" option to create/re-create recent editions over the past day or so.',

  'Edition layout placeholder':
    '# HEAD\n@*: #BreakingNews\n@insightful.quietposter\n\n## Workplace - common section for all editions\n@coworker1\n@coworker2\n\n# 08:00 Morning Edition\n@always.interesting.bsky.social\n@sometimes.interesting: topic, second topic\n\n## Substacks in the morning\n@author1.com: blogname1.substack.com \n@author2.bsky.social: blogname2.substack.com \n\n# 12:00 Noon Edition\n## Humor\n@xkcd.com\n@phdcomics.com\n\n# 18:00 Evening Edition\n## Coding\n@simonwillison.net\n\n# TAIL\n## Catchall common section\n@author1.com',
}

/** Look up a glossary term (case-insensitive). Returns undefined if not found. */
export function getGlossaryDefinition(term: string): string | undefined {
  if (helpGlossary[term]) return helpGlossary[term]
  const lower = term.toLowerCase()
  const key = Object.keys(helpGlossary).find(k => k.toLowerCase() === lower)
  return key ? helpGlossary[key] : undefined
}
