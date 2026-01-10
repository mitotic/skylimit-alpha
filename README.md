# Skylimit: A curating web client for Bluesky with fine-grained controls to mimic the newspaper experience


Skylimit is a working *proof-of-concept* software that implements a client-side algorithm for the [Bluesky](https://bsky.app/) microblogging network.

**Note: This is raw alpha-quality software with many bugs. It is meant to demonstrate the potential for the algorithm and is not yet ready for routine use.**

The goal of many social media platforms is to maximize your screen time. Skylimit is a curation algorithm designed to optimize your limited screen time. It attempts to answer the following question: *If I decide to limit myself to viewing, say, 500 posts per day (on average), what is the best way to manage my Following Feed?*

As a Bluesky user who follows many people, I would like to view the most relevant/interesting posts in my feed. This is similar to the decisions editors make when populating a fixed number of pages in a printed newspaper—they must choose from news items on numerous topics, regular pieces by columnists, etc. Skylimit aims to mimic aspects of the print newspaper reading experience in the digital world by creating a curated version of the Following Feed with statistical settings for each followee that go beyond just muting.

When you use Skylimit, you start by specifying how many posts you wish to view per day *on average*. On some days you'll view more and on some days less, depending upon how active your followees are each day. Statistics of your feed activity, computed over a period (usually 30 days), are used to enforce this "soft" limit.

A basic premise of Skylimit is that if you follow someone, you wish to see at least some of the content they post. We'd like to listen to different voices in the media, but commercial algorithms may promote a louder voice more than a softer voice. Posts by "less popular" users may never be seen even by people who follow them. This often discourages such users from posting at all.

By default, Skylimit will guarantee each of your followees a certain number of views (or impressions) per day, known as the *Skylimit Number*. The default Skylimit Number will be typically larger than the number of desired daily views divided by the number of followees, because not all your followees will post that frequently. Say you follow 150 people and wish to view 300 posts per day, the default Skylimit Number may be 7, rather than 2.

Relying on your natural (rather than artificial) intelligence, Skylimit allows you to easily *amp up* (or *amp down*) the Skylimit Number of any followee, to allow more or fewer views per day. You can use this feature to ensure that you always see someone's posts. You can also use it to reduce views of those who post interesting stuff, but too much of it every day. Typically, you will need to adjust the Skylimit number only for a fraction of your followees to take control of your feed. Doing that can free up view time that you can use to follow more people and explore different content.

When you amp up a followee, it will boost their own Skylimit Number, but lower the default Skylimit Number because the others will receive a somewhat smaller share of the average daily views. The amped up (or amped down) Skylimit numbers remain private and will not be seen by any of your followees. (You may choose to publicly advertise your default Skylimit number in your Bluesky bio, so that any followee will know how likely you are to see their posts.)

If someone you follow generates less than their Skylimit Number of posts per day, all their posts are guaranteed to appear in your timeline. If they generate more, then Skylimit will display a random subset equalling their Skylimit Number. (There are optional/experimental features under development that will enable either you or the followee to prioritize which of their posts will be displayed.)

Skylimit will also implement a feature where you can curate some posts into digests or "editions" during specific times of the day. For example, you can configure posts from certain followees (or on certain topics) to be collected and displayed in a *Morning Edition* at 9 AM and *Evening Edition* at 6 PM (say). This feature is still in an early stage of development.


## Trying out Skylimit

You can try out Skylimit at [https://skylimit.dev](https://skylimit.dev) using a web browser. 

To use Skylimit, simply log in using a Bluesky app password and start browsing. You can go to the *Settings > Skylimit Settings* menu to see the configuration options.

When you start using Skylimit, it will begin to analyze your feed and compute the statistics on the posting behavior of your followees. Initially, Skylimit usually has about a day's worth of data to analyze but it will slowly accumulate data as you continue to use it. All the statistical data is stored in your browser, not on any server, ensuring privacy. If you use Skylimit from a different browser, it will compute the statistics separately there. (There will be a way to manually export and import statistical settings between browsers.)

The posting statistics for all your followees are displayed at the bottom of the *Settings > Skylimit Settings* page, sorted in descending order of posts per day. You can *amp up* (or *amp down*) a followee.

Remember that Skylimit is alpha-quality software that is being actively developed and will frequently break. *As long as you do not use Skylimit to post, repost, like or reply to posts*, it is unlikely to damage your Bluesky account because Skylimit is a standalone web client that stores all its curation data in the web browser (no data is sent to the Bluesky server). You can continue to access Bluesky using any other web client or phone app with no interference from Skylimit.

The Skylimit algorithm is derived from the Mahoot algorithm for Mastodon described here:
 [Mahoot User's Guide](https://github.com/mitotic/pinafore-mahoot/blob/master/docs/MahootUserGuide.md)
 

## Author(s)

 [R. Saravanan](https://github.com/mitotic) ([sarava.net](https://bsky.app/profile/sarava.net) on Bluesky), with a lot of assistance from Cursor.AI and Claude Code


## Running it yourself

Instead of using the [Skylimit.dev](https://skylimit.dev) website, you can also download the Skylimit [source code](https://github.com/mitotic/skylimit-alpha) and run it on your desktop/laptop computer following the instructions below. 

    npm install
    npm run dev

The dev server will start at http://localhost:5181 (as configured in vite.config.ts).

