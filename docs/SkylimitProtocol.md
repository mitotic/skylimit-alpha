# Skylimit Protocol

R. Saravanan ([@sarava.net](https://bsky.app/profile/sarava.net) on Bluesky)

*The code implementing this protocol can be found primarily in these two files on Github: [skylimitStats.ts](https://github.com/mitotic/skylimit-alpha/blob/main/src/curation/skylimitStats.ts), [skylimitFilter.ts](https://github.com/mitotic/skylimit-alpha/blob/main/src/curation/skylimitFilter.ts)*

The Skylimit protocol probabilistically selects a subset of posts from a user's followees to display in the timeline. To do that, Skylimit saves metadata for posts over an averaging period (default: 30 days) to compute the posting statistics for each followee. The user specifies the average number of total posts that they wish to view per day, V. We need to compute the *default Skylimit Number* M<sub>def</sub>, which is the maximum number of views allowed per followee.

Say the average number of total posts from the followees is P<sub>tot</sub>. If P<sub>tot</sub> &lt; V, then all posts can be viewed. In this case, M<sub>def</sub> is set to P<sub>max</sub>, where P<sub>max</sub> is the number of posts per day from your most prolific followee.

Otherwise, some posts will need to be dropped. To compute M<sub>def</sub>, sort the followees by the number of posts per day, P<sub>user</sub>, in ascending order. The number of available daily views is V. Start from the least active followee and allocate P<sub>user</sub> views to each. Divide the remaining views by the remaining number of followees to estimate the Skylimit Number. This estimate will keep increasing for a while, because the least active followers are "below average" consumers of views. When the estimate stops increasing, that maximum value is the default Skylimit Number M<sub>def</sub>. Every followee is allowed up to M<sub>def</sub> views per day.

We can treat the followees differentially by assigning an *amplification factor* F<sub>user</sub> to each followee. You can then estimate M<sub>def</sub> using the same method&mdash;by pretending that an F<sub>user</sub> value of 2 means that followee is effectively two followees and so on. The user-specific Skylimit Number M<sub>user</sub> is M<sub>def</sub> times the amplification factor, F<sub>user</sub>. The amplification factor ranges from 0.125 (1/8x) to 8.0 (8x).

For followees who post less than their M<sub>user</sub> value, the probability of viewing their post is 1. For followees who post more than their M<sub>user</sub> value, the probability of viewing their post is M<sub>user</sub> / P<sub>user</sub>, where P<sub>user</sub> is their daily posting rate. Usually, only a small fraction of a user's followees post more than the default Skylimit Number.


## Interval-based statistics

Unlike earlier implementations, Skylimit uses interval-based analysis for statistics. Posts are grouped into configurable time intervals (default: 2 hours; valid values: 1, 2, 3, 4, 6, 8, 12 hours&mdash;all factors of 24). The "complete intervals" algorithm determines which intervals have reliable data:

An interval is considered *complete* if it has a non-zero post count and both of its chronological neighbors also have non-zero counts. Boundary intervals (the first and last in the range) are always treated as incomplete. Statistics are derived primarily from complete intervals, which improves accuracy by excluding periods where data collection may have been interrupted (e.g., when the user was not actively browsing).

For each followee, an effective day count is computed based on when they were first observed posting, using a partial interval amplification factor to account for incomplete data. A configurable minimum followee day count (default: 1) prevents inflated posting rates for recently followed accounts.


## Post prioritization

Posts can be [prioritized](UserGuide.md#prioritized-posts) so that "more important" posts are more likely to be displayed. There are three priority levels, from highest to lowest:

1. **Periodic posts** (#MOTD, #MOTW, #MOTM): Guaranteed display (one per period per account). If a followee's Skylimit Number M<sub>user</sub> falls below 1.0, their #MOTD posts lose their priority.

2. **Priority posts**: Posts with hashtags matching the followee's Topics parameter, or posts tagged #priority. If the number of daily prioritized posts Q<sub>user</sub> &lt; M<sub>user</sub>, all priority posts are shown and the remaining views are allocated to regular posts with probability (M<sub>user</sub> - Q<sub>user</sub>) / (P<sub>user</sub> - Q<sub>user</sub>). If Q<sub>user</sub> &ge; M<sub>user</sub>, only priority posts are shown with probability M<sub>user</sub> / Q<sub>user</sub>.

3. **Regular posts**: Original posts, followed replies, unfollowed replies, and reposts that are neither periodic nor priority.


## Reply handling

Replies are categorized into two types: replies to followed accounts and replies to non-followed accounts. During the initial lookback period (first curation round), all unfollowed replies are dropped. After that:

- If the "Hide replies to non-followees" setting is enabled, all unfollowed replies are dropped.
- If the setting is disabled, unfollowed replies are shown only from "quiet posters"&mdash;followees whose regular show probability is 1.0 (i.e., all their regular posts are already shown).


## Repost deduplication

A configurable repost display interval (default: 24 hours, range: 0&ndash;96 hours) prevents seeing the same content multiple times. If the original post or another repost of the same post was displayed within this interval, the repost is dropped. Setting the interval to 0 disables this feature.


## Post display consistency

A probabilistic curation protocol should be consistent, i.e., it should select the same subset of posts to display regardless of which device is used. To achieve this, Skylimit uses HMAC-SHA256 to generate a deterministic random number from each post's unique identifier (its AT Protocol URI for original posts, or the repost URI for reposts) combined with a configurable secret key. The HMAC value determines whether a particular post should be displayed in the timeline.

If the same secret key is used across devices, the same subset of posts will be selected for display. A different secret key can be set if the user suspects a server might adjust post identifiers to influence the random selection.


## Edition digests

Posts from configured accounts can be collected during curation intervals and displayed at scheduled times as digest "editions" (e.g., a Morning Edition at 08:00 and an Afternoon Edition at 15:00). An edition layout specifies which accounts appear in which sections. Posts tagged #nodigest are excluded; posts tagged #digest are included. Posts saved for editions are marked with the `edition_drop` status and removed from the regular feed.
