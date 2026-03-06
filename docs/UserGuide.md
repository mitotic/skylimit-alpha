# Skylimit User Guide

Version 0.1

- [Getting Started](#getting-started)
- [Browsing Your Feed](#browsing-your-feed)
- [Interacting with Posts](#interacting-with-posts)
- [Viewing Threads](#viewing-threads)
- [Profiles and Following](#profiles-and-following)
- [Notifications](#notifications)
- [Search](#search)
- [Saved Posts](#saved-posts)
- [Settings Overview](#settings-overview)
- [Skylimit Curation](#skylimit-curation)
- [Caveats](#caveats)

Skylimit is a working *proof-of-concept* software that implements a curation algorithm for the [Bluesky](https://bsky.app/) microblogging network. It provides fine-grained control on how you consume your Bluesky Following Feed. The [README](https://github.com/mitotic/skylimit-alpha#readme) provides background on the motivations behind Skylimit. The [protocol document](SkylimitProtocol.md) describes the algorithm in detail.


## Getting Started

### Creating a Bluesky App Password

Skylimit uses Bluesky *app passwords* for authentication. You cannot use your main account password. To create one:

1. Go to [Bluesky App Password Settings](https://bsky.app/settings/app-passwords)
2. Click "Add App Password"
3. Give it a name (e.g., "Skylimit")
4. Copy the generated password

### Logging In

You can try out Skylimit at [https://skylimit.dev](https://skylimit.dev) using a web browser. There is currently no separate phone app available, but Skylimit works on mobile browsers.

<p align="center">
<img src="images/LoginPage.png"
     alt="Skylimit login page">
<br>
<em>Login page</em>
</p>

Enter your Bluesky handle (e.g., `you.bsky.social`) and the app password you created. The **Remember me** option controls session persistence:

- **Checked**: Session stored in `localStorage` (persists across browser sessions)
- **Unchecked**: Session stored in `sessionStorage` (cleared when browser closes)

Skylimit is a static website that stores all its data locally in your browser, not on any server or in the cloud. This ensures privacy and it also means that Skylimit will not interfere with any other Bluesky client that you are currently using.

### Connecting to a Test Server

For development and testing, Skylimit can connect to the [Skyspeed](AdminGuide.md#skyspeed-test-server) test server by adding a `?server=` parameter to the URL (e.g., `http://localhost:5181/?server=localhost:3210`). A confirmation dialog will appear and the curation cache will be reset.


## Browsing Your Feed

### Home Timeline

After logging in, you will see your curated Following Feed on the Home page. The Home page has two tabs:

- **Curated**: Your Following Feed with Skylimit curation applied. Posts that don't pass the curation filter are hidden (or shown grayed out if the "Show dropped posts" setting is enabled).
- **Editions**: Digest editions of selected posts, if you have configured edition times and layout (see [Edition Digests](#edition-digests)).

<p align="center">
<img src="images/HomeTimeline.png"
     alt="Skylimit home timeline">
<br>
<em>Home timeline showing the curated Following Feed</em>
</p>

### Paged Navigation

By default, posts are displayed in pages. At the top and bottom of the feed you will see navigation controls:

- **New Posts** button: Appears when new content is available. Click it to load the latest posts.
- **Prev Page**: Navigate to older posts.
- **Next Page**: Navigate to newer posts.

You can switch to infinite scrolling mode in Settings (see [Advanced Settings](#advanced-settings)).

<p align="center">
<img src="images/HomeNewPosts.png"
     alt="Home page with New Posts button">
<br>
<em>New Posts button appears when new posts are available</em>
</p>

### Post Counter and Timestamps

If the "Display post timestamp" setting is enabled, each post shows a timestamp in the format `hh:mm#nnn`, where `hh:mm` is the post time and `#nnn` is a sequential counter that resets at midnight local time. The counter makes it easy to track how many posts have appeared in your timeline each day.

### Curation Indicators

Posts carry curation metadata that can be viewed by clicking on the show probability or curation status indicator. This opens a popup showing:

- The followee's posting rate (posts per day)
- Show probability (percentage)
- Amplification factor
- Drop reason (if the post was filtered out)

<p align="center">
<img src="images/PostCurationPopup.png"
     alt="Curation popup on a post">
<br>
<em>Curation popup showing post statistics and drop reason</em>
</p>


## Interacting with Posts

### Likes and Reposts

Each post has action buttons at the bottom:

- **Like** (heart icon): Like or unlike a post. Changes take effect immediately with optimistic UI updates.
- **Repost** (repost icon): Opens a menu with options to repost (pure repost) or quote post (add your own commentary).
- **Reply** (reply icon): Opens the compose dialog to write a reply.
- **Bookmark** (bookmark icon): Save a post for later viewing.

### Composing Posts

Click the compose button in the header to create a new post. You can also compose replies via the reply button on any post, or create quote posts via the repost menu.


## Viewing Threads

Click on a post's text to open the thread view. The thread page shows:

- **Parent chain**: The chain of parent posts leading to the focused post
- **Focused post**: The post you clicked on, highlighted
- **Replies**: Direct replies to the focused post, with pagination for large threads

<p align="center">
<img src="images/ThreadView.png"
     alt="Thread view showing parent chain and replies">
<br>
<em>Thread view with parent chain and replies</em>
</p>

*Tip*: Click on the text portion of a post to open the thread view. Clicking on an image or thumbnail may open the media viewer instead.


## Profiles and Following

Click on a user's avatar or handle to view their profile. The profile page shows the user's bio, follower/following counts, and their posts in three tabs:

- **Posts**: Original posts (excluding replies)
- **Replies**: Posts and replies
- **Likes**: Posts the user has liked

You can follow or unfollow a user directly from their profile page.

<p align="center">
<img src="images/ProfilePage.png"
     alt="User profile page">
<br>
<em>User profile page</em>
</p>


## Notifications

The Notifications page shows aggregated notifications including:

- **Likes**: "N people liked your post"
- **Reposts**: "N people reposted your post"
- **Follows**: New followers
- **Replies**: Replies to your posts
- **Quotes**: Posts that quote your post
- **Mentions**: Posts that mention you

Notifications are paginated with 25 per page.

<p align="center">
<img src="images/NotificationsPage.png"
     alt="Notifications page">
<br>
<em>Notifications page with aggregated items</em>
</p>


## Search

The Search page allows you to search for users by username or display name. Click on a result to navigate to their profile.

*Note*: Post search is not currently available due to AT Protocol limitations.

<p align="center">
<img src="images/SearchPage.png"
     alt="Search page">
<br>
<em>Search results for users</em>
</p>


## Saved Posts

The Saved page shows all posts you have bookmarked. You can remove bookmarks from this page. Posts are paginated with 25 per page.

<p align="center">
<img src="images/SavedPage.png"
     alt="Saved posts page">
<br>
<em>Saved/bookmarked posts</em>
</p>


## Settings Overview

The Settings page has three tabs:

### Basic Tab

- **Account**: Shows your logged-in username with a Logout button
- **Navigation**: "Click to Bluesky" toggle&mdash;when enabled, posts, profiles, and notifications open in the official Bluesky client. Return to Skylimit by using back navigation.
- **Appearance**: Light/dark theme toggle
- **About**: Project description, technology stack, and GitHub link

<p align="center">
<img src="images/SettingsBasic.png"
     alt="Settings Basic tab">
<br>
<em>Settings Basic tab</em>
</p>

### Curation Tab

Contains all Skylimit curation settings (see [Skylimit Curation](#skylimit-curation) below).

### Following Tab

Displays posting statistics for all your followees (see [Posting Statistics](#posting-statistics) below).


## Skylimit Curation

### How Curation Works

Skylimit probabilistically selects a subset of posts from your followees to fit within your viewing budget. The algorithm computes statistics from accumulated feed data over a configurable period (default: 30 days) to determine the probability of displaying each post.

All curation data is stored locally in your browser using IndexedDB. No curation data is sent to any server, ensuring privacy. If you use Skylimit from a different browser, statistics will be computed independently there.

Curation will not interfere with other Bluesky clients you may be using. You can continue to access Bluesky using the official app or any other client alongside Skylimit.

### Basic Curation Settings

<p align="center">
<img src="images/SettingsCuration.png"
     alt="Curation settings">
<br>
<em>Curation tab with basic settings</em>
</p>

The most important setting is **Average views per day** (range: 10&ndash;9999). This is the number of posts you wish to view per day *on average*. Since this is a "soft" limit that is imposed statistically, on days that your followees post more, you will see more posts. On other days, it will be less.

Click the **Update Curation Settings** button to save changes. Some changes may require a page reload to take effect.

### The Skylimit Number

The *Skylimit Number* is the core metric of the curation algorithm. It represents the guaranteed number of views per day for each followee. If a followee posts fewer than their Skylimit Number of posts per day, all their posts are shown. If they post more, a random subset equal to their Skylimit Number is selected.

The default Skylimit Number is typically larger than the number of desired daily views divided by the number of followees, because not all followees post frequently. For example, if you follow 150 people and wish to view 300 posts per day, the default Skylimit Number might be 7 rather than 2.

See the [protocol description](SkylimitProtocol.md) for the mathematical details of how the Skylimit Number is computed.

### Posting Statistics

The **Following** tab displays posting statistics for all your followees.

<p align="center">
<img src="images/FollowingSummary.png"
     alt="Following tab summary statistics">
<br>
<em>Summary statistics showing the Skylimit Number, total posts per day, and analysis period</em>
</p>

At the top, a summary panel shows:

- **Skylimit Number**: The current default guaranteed views per day per followee
- **Posts/day**: Average daily post count across all followees
- **Followees**: Number of followed accounts
- **Analysis period**: Number of days of data being analyzed

Below the summary, the **Active Followees** table shows per-followee statistics sorted by posts per day:

- **Handle**: The followee's Bluesky handle
- **Posts/day**: Average posts per day from this followee
- **Shown/day**: Number of posts shown per day (with probability percentage)
- **Name**: The followee's display name

<p align="center">
<img src="images/FollowingTable.png"
     alt="Active Followees table">
<br>
<em>Active Followees table showing posting statistics for each followee</em>
</p>

Click on the probability percentage to open a curation popup with detailed statistics and controls for amping up or down.

*Note*: When you first start using Skylimit, it may take a few minutes for the statistics to appear as data accumulates.

### Amplification Factors

The *amplification factor* allows you to increase or decrease the visibility of posts from specific followees. The factor ranges from 0.125 (1/8x) to 8.0 (8x). The default is 1.0.

<p align="center">
<img src="images/CurationPopupStats.png"
     alt="Curation popup with amp buttons">
<br>
<em>Curation popup showing statistics and amplification controls</em>
</p>

You can adjust the amplification factor from the curation popup:

- **Amp Up**: Increases the factor by 40% (multiply by 1.4)
- **Amp Down**: Decreases the factor by 30% (multiply by 0.7)

When you amp up a followee, it boosts their own Skylimit Number but slightly lowers the default Skylimit Number for other followees, because others will receive a smaller share of the daily views. The amped up (or amped down) Skylimit numbers remain private and will not be seen by any of your followees.

Typically, you will only need to adjust the amplification factor for a small fraction of your followees to take control of your feed.

### Advanced Settings

<p align="center">
<img src="images/SettingsExperimental.png"
     alt="Advanced and experimental settings">
<br>
<em>Advanced settings section</em>
</p>

- **Display post timestamp (hh:mm) in home feed**: Shows the post time and a sequential counter for each post in the home timeline.

- **Show dropped posts (as grayed out)**: By default, posts dropped by curation are hidden. Enabling this shows them grayed out, allowing you to check how the curation algorithm is working. Click the curation indicator to see why a post was dropped.

- **Suspend curation**: Temporarily turns off Skylimit filtering and shows all posts.

- **Enable "infinite" scroll down**: Switches from paged navigation to infinite scrolling mode.

- **Full Page Wait Time** (5&ndash;120 minutes, default 30): How long to wait for enough posts to fill a complete page before showing a partial page.

- **Repost Display Interval** (0&ndash;96 hours, default 24): Hides reposts if the original post or another repost was shown within this time interval. Set to 0 to disable. This prevents seeing the same content multiple times.

- **Days of data to analyze** (1&ndash;60 days, default 30): The maximum number of days of feed data to analyze for computing statistics. Capped at 60 days to avoid computational overload.

- **Seed string for randomization**: Skylimit generates deterministic random numbers to [select which posts to display](SkylimitProtocol.md#post-display-consistency). These numbers depend upon the unique identifier of each post and this secret key. Whatever the key value, it should be the same across all your devices to ensure the same random subset of posts is displayed.

### Experimental Settings

- **Digest edition times**: Comma-separated local times (e.g., `08:00,15:00`) when digest editions should be compiled and displayed (see [Edition Digests](#edition-digests)).

- **Digest edition layout**: Specifies which accounts appear in digest editions and how they are organized into sections (see [Edition Digests](#edition-digests)).

- **Anonymize usernames**: Facilitates sharing screenshots by replacing usernames with anonymized identifiers.

- **Skylimit Debug Mode**: Enables additional debug settings and detailed statistics display. When enabled, the following additional settings appear:

<p align="center">
<img src="images/SettingsDebug.png"
     alt="Debug mode settings">
<br>
<em>Debug mode settings (visible when Skylimit Debug Mode is enabled)</em>
</p>

  - *Feed Redisplay Idle Interval* (1&ndash;480 minutes, default 240): Time before the cached feed is discarded and reloaded from the server.
  - *Feed Page Length* (10&ndash;100 posts, default 25): Number of posts per page. Initial load from cache shows twice this amount.
  - *Max Displayed Feed Size* (50&ndash;500 posts, default 300): Maximum posts kept in the displayed feed. Older posts are trimmed during navigation.
  - *Variability Factor* (1&ndash;3, default 2): Multiplier for raw posts to fetch, accounting for filtering variability.
  - *Curation Interval* (1, 2, 3, 4, 6, 8, or 12 hours, default 2): Time period for grouping posts in statistics calculations. Must be a factor of 24.
  - *Hide replies to non-followees* (default off): When enabled, all replies to non-followees are hidden. When disabled, replies from "quiet posters" (those with 100% show probability) are shown.


### Periodic Posts (MOTD/MOTW/MOTM)

Skylimit supports periodic post tags that help even low-volume posters reliably get their message across to followers:

- **#MOTD** (Message Of The Day): One post per day receives the highest priority
- **#MOTW** (Message Of The Week): One post per week receives the highest priority
- **#MOTM** (Message Of The Month): One post per month receives the highest priority

Periodic posts are automatically given the highest curation priority. If a followee's Skylimit Number falls below 1.0, their #MOTD posts lose their priority. If a followee posts more than one #MOTD per day, only one (randomly chosen) will receive the special treatment.

Add **#Digest** to include periodic posts in the next Digest Edition.

### Prioritized Posts

Posts can be [prioritized](SkylimitProtocol.md#post-prioritization) so that "more important" posts are more likely to be displayed. A followee can specify a `Topics` parameter in their profile with a list of hashtags. Posts containing those hashtags will be treated as priority posts. The hashtag **#priority** can be used to override topic restrictions and force priority treatment.

Different show probabilities are computed for priority posts versus regular posts. The views available to a followee are first allocated to their periodic posts, then to priority posts, and finally to regular posts.

### Edition Digests

This feature is inspired by newspapers, where information arrives at specific times, organized into sections. You can configure posts from certain followees to be collected and displayed in digest "editions" at scheduled times.

The **Digest edition times** setting (e.g., `08:00,15:00`) specifies when editions are compiled. The **Digest edition layout** specifies which accounts appear in each edition, using this format:

```
@user1.bsky.social @user2.bsky.social#hashtag
SectionName
@user3.bsky.social @user4.bsky.social#motx
AnotherSection
@user5.bsky.social
```

- Usernames can be suffixed with `#hashtag` to include only posts with that specific hashtag
- `#motx` suffix includes all periodic posts from the user
- Plain section names (without `@`) define named sections in the edition
- Posts tagged **#nodigest** are excluded from editions
- Posts tagged **#digest** are included in the next edition

<p align="center">
<img src="images/EditionsTab.png"
     alt="Editions tab with digest edition">
<br>
<em>Editions tab showing a digest edition</em>
</p>

### Data Management

The Data Management section at the bottom of the Curation tab provides tools for managing cached data:

- **Show Cache Gaps**: Displays time ranges for both the feed cache and post summaries cache, helping identify gaps in data collection.

<p align="center">
<img src="images/CacheGaps.png"
     alt="Cache gaps analysis">
<br>
<em>Cache gaps analysis showing feed and summaries cache time ranges</em>
</p>

- **Cache Statistics** (debug mode only): Shows detailed cache sizes, timestamps, and drop percentages.

The following reset options are available:

- **Reset feed**: Clears the displayed feed and pagination state, but preserves post summaries and settings. The feed will be reloaded from the server.
- **Reset curation**: Clears the feed and all post summaries, but preserves settings. Statistics will be recomputed from scratch.
- **Reset Skylimit settings**: Restores all curation settings to their defaults.
- **Reset all**: Complete factory reset&mdash;clears all data and logs out.

If the app fails to load due to a database error (e.g., an IndexedDB version conflict after testing a different version of the app), you can add `?clobber=1` to the URL (e.g., `http://localhost:5181/?clobber=1` or `https://skylimit.dev/?clobber=1`) to delete all site data and start fresh. This is equivalent to using the browser's "Clear site data" option in DevTools, and is especially useful on mobile devices where DevTools are not available.


## Caveats

- If a change in settings doesn't seem to have any visible effect, *reloading* the web page may help.

- To update to the latest version of Skylimit on the website, a hard refresh of the browser is usually needed (Ctrl+Shift+R on Windows/Linux, Cmd+Shift+R on Mac).

- Remember that Skylimit is alpha-quality software that is being actively developed and may occasionally break. However, it will not damage your Bluesky account because Skylimit stores all its curation data in the web browser. You can continue to access Bluesky using any other web client or phone app with no interference from Skylimit.

- All curation data is local to each browser. If you switch browsers, Skylimit will compute statistics independently in the new browser.
