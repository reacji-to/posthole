# posthole

[posthole.ink](https://posthole.ink) · [Download and install](https://posthole.ink/#install)

A Helium (or Chrome) extension that saves every post you scroll past on **X, LinkedIn, Bluesky, Threads and Hacker News** to a folder on your computer. Each post is saved as a structured JSON record in one schema for every site, along with its images, video, link preview and author avatar.

posthole reads posts from the same data the site loads for itself, not from the rendered page:

| Site | Source |
| --- | --- |
| X | GraphQL responses (`HomeTimeline`, `TweetDetail`, `UserTweets`, search, bookmarks, …) |
| Bluesky | XRPC responses (`getTimeline`, `getFeed`, `getPostThread`, …) |
| Threads | JSON embedded in the page, then GraphQL responses |
| LinkedIn | The feed's server-driven UI stream (React Server Components) for feed pages and scrolling, and Voyager API responses on older pages |
| Hacker News | The page HTML (stories and, on item pages, comments) |

Ads and promoted posts are skipped. Reposts save the original post and record who reposted it. See [SCHEMA.md](SCHEMA.md) for the record format and folder layout.

Everything is on by default:

- **Reply threads.** For every post with replies, posthole fetches its reply thread in the background, even if you never open it, and replies to those replies up to two levels deep. It asks each site's own API with your signed-in session, from an open tab of that site, spaced out per site (X also honors its rate-limit headers and leaves headroom for your own browsing). Bluesky threads come from the public API. The queue survives browser restarts.
- **Raw archive.** Every API response and page is kept exactly as received under `raw/`, gzipped, so anything can be re-parsed or rebuilt later.
- **All files:** full-resolution images, videos, link-preview images and avatars, plus each post's `source.json`.

## Install

Requires Node.js 20 or later.

```bash
npm install
npm run build
npm run install-host
```

`install-host` registers the small file-writing helper (`host/posthole-host.mjs`) with Helium, and with Chrome or Chromium if they are installed. The helper starts automatically when the extension needs it and writes only inside your save folder.

Then in Helium open `helium://extensions` (or `chrome://extensions`), turn on **Developer mode**, choose **Load unpacked**, and select this repo's `dist/` folder. The extension ID is always `eeagnagddgglgkipenejhengibolcjda`, because `manifest.json` pins its key and the helper only answers that ID.

Open the extension's settings to choose the save folder. The default is `~/posthole`.

## Use

Browse normally. The toolbar badge counts the posts saved this session, and the popup shows a count per site, the last post saved, and a pause switch. A red `!` means the helper isn't reachable; the popup says what to do.

Settings:

- **Save folder**: type a path or use **Choose…**
- **Sites**: turn each site on or off, and choose whether to save Hacker News comments
- **Files**: images and documents, videos and GIFs, author avatars, a size limit, and whether to keep each post's `source.json`
- **Reply threads**: on or off, how many levels of replies-to-replies, and how many pages of replies per post. The status line shows what's waiting and the last result per site.
- **Raw archive**: keep every API response and page under `raw/`

X and LinkedIn thread fetching replays the requests their own web apps make: X's `TweetDetail` (shaped like the client's own requests, paced, and paused near X's rate limit), and on LinkedIn each post's own "load comments" request, which the feed already contains. Threads needs you to open any post once so posthole can learn its request. Fetching replies at volume is unusual account activity; lower the depth or turn thread fetching off if a site complains.

Assets are downloaded by the extension's background worker at full resolution. It reuses the browser's cached copy when it has one, but sites usually display a smaller rendition than the original, so most assets are fetched again.

## Browse what you saw

A local site with a card for every post you scrolled past, in the order you saw it, split into browsing sessions. Each card can expand the reply thread posthole fetched for it. Cards use source-specific layouts, rounded edges, saved images and videos, and selectable text rendered from the records—not screenshots. X long posts keep their original feed preview with a Show more control. Source timestamps are frozen at the last saved observation.

```bash
cd viewer && bun install && bun start   # http://localhost:4747  (--dir to read another save folder)
```

Use the **Interface** menu to read the same archive eight ways: original site cards, Poster News, Postpod classic, Postpod color, Swipe, Gallery, Terminal, or Postflix. The interface is independent of the source filter: you can read LinkedIn posts in the Poster News view, for example. Search, ordering, saved media, quotes, and reply threads keep working. Your choice is remembered in this browser, and `?view=ipod-color` (or another interface ID) makes a direct link.

- **Postpod:** next/previous buttons move between posts. Left opens the menu; Up/Down move through its list or scroll the open post; Right opens the selected post; Space plays or pauses video. Scrolling on the click wheel also moves through the list or scrolls the open post. MENU replaces the screen with a scrollable post list; the wheel changes its selection and the center button opens that post. Play/pause controls the current post's video. Both themes share the same larger 4:3 screen and navigation. The classic screen uses a true 1-bit black/white threshold on its entire display, including images and videos.
- **Swipe:** swipe left to skip or right to keep, or use the on-screen buttons. **Kept posts** filters the deck to your keeps; the heart can also remove a keep. These are stored only in this browser, not in the archive, and never like or delete a post on its source site.
- **Postflix:** browse a featured post and horizontal rows of videos, images, and posts from each source. Play a saved video or open its detail panel to read the full post and replies. Load more posts to expand the catalogue.
- **Hacker News:** open a headline to read its full saved post and media. **Gallery** puts media first; **Terminal** uses a compact monospace reading surface.

These interfaces are available in the local server. Generated static archive sites retain the original source-specific cards.

## Publish to GitHub

When the save folder is a git repository, the extension commits and pushes it every 5 minutes (setting: **GitHub**). It also installs a workflow that runs every 15 minutes, and that workflow:

- appends the posts saved since its last run to a static version of the card site and deploys it to GitHub Pages;
- adds them to `posthole.sqlite` with full-text search and embeddings from a local model (see [SCHEMA.md](SCHEMA.md)), attached to the `posthole-index` release.

One-time setup with the GitHub CLI and Git LFS (it uses the repository if it already exists):

```bash
node scripts/github-setup.mjs --repo you/posthole
```

Things to know:

- **GitHub Pages sites are public**, even from a private repository. A private repository needs a paid plan (GitHub Pro or above) for Pages at all; access-controlled Pages exists only on GitHub Enterprise Cloud. The site lists every post you scrolled past.
- **Media on the site:** a public repository's site loads saved media straight from the repository. A private repository's site can't, so it gets its own resized WebP copies of the images and avatars it shows (reply threads copy avatars only), and videos link to their original.
- **Everything is pushed.** Files over 95 MB (long videos) go through Git LFS, up to GitHub's 2 GB per-file limit, and pushes are split into batches of at most 400 MB. Responses that could carry sign-in material are never archived or pushed.
- **Actions minutes:** a 15-minute schedule is about 100 runs a day. That's free for public repositories; for private ones it's roughly a month of GitHub Pro's 3,000 included minutes.
- `posthole.sqlite` lives on the `posthole-index` release, not in git, because it is rewritten every run and outgrows git's 100 MB file limit.

## Develop

```bash
npm test            # parser and helper tests (Node test runner)
npm run test:viewer # card rendering and static build tests (Bun)
npm run package     # build release/posthole.zip with the extension and local helper
npm run test:e2e    # loads dist/ into Chromium with the real helper, browses HN and Bluesky, checks threads and raw/
npm run watch       # rebuild on change
npm run icons       # re-render icons/ from scripts/icons.mjs
npm run rebuild -- ~/posthole /tmp/rebuilt   # re-parse raw/ into fresh records (after a parser fix, omit the output folder to update in place)
```

After `npm run build`, the running extension notices the new build within a minute (through the helper), reloads itself, and re-attaches to tabs that are already open, so there is no need to touch `helium://extensions` again. Pages that were open before an update are captured from that point on; reload a tab to also capture what it loaded first.

Layout:

- `src/hook.js` runs in the page's own JavaScript world and passes copies of API responses to `src/content.js`
- `src/parsers/` turn each site's data into `posthole.post/1` records (`src/schema.js`); `src/rsc.js` reads LinkedIn's React Server Components stream
- `src/expand.js` builds the reply-thread requests; `src/background.js` queues them, de-duplicates posts, talks to the helper, and downloads assets
- `host/posthole-host.mjs` is the native messaging helper that writes `post.json`, `source.json`, media and the daily index, and commits and pushes to GitHub
- `viewer/` is the Bun + Hono card site (`server.tsx` locally, `build-static.tsx` for GitHub Pages)
- `github/` holds the workflow and indexer the helper installs into the save folder's repository

The Bluesky and Hacker News fixtures in `tests/fixtures/` are real responses. The X, Threads and LinkedIn fixtures (`*.synthetic.*`) are hand-built from those sites' known data shapes; replace them with captures from `raw/` when available.

### Reading status and automatic scrolling

The local viewer shows **Read / Unread** controls on posts. Opening a story, expanding its text or replies, playing its video, or opening a Postflix detail panel marks it read. Click **Read** to mark it unread again. Scrolling past a post does not mark it read. Read history stays in this browser and is shared across the viewer’s interfaces; it is separate from capture history and is not synced to another browser.

In the extension popup, **Auto-scroll** lets you choose 1–120 minutes and start scrolling the current supported feed. Scroll distances vary from about a quarter to nine tenths of a viewport, with pauses of 2–9 seconds and occasional 12–24 second pauses. You can switch tabs; **Stop** remains available from the popup. The run stops at its deadline, when saving is paused, when the tab navigates or closes, or after a minute without further scrolling content. Keep the browser open; sleeping computers, suspended tabs, and sites that pause their feeds in the background can interrupt progress. The extension never switches to the tab or clicks posts for you. **Save reply threads** controls the existing background reply queue: posts with known replies are fetched through the site’s thread requests, within the configured page/depth limits and rate-limit backoff. This setting is independent of auto-scroll; queued reply fetching can continue after scrolling stops.

**Check for updates** checks the native helper for a newer local build and reloads the extension when one is available. For this unpacked installation, download source updates and run `npm run build` first; the button does not pull from GitHub. New local builds are also detected automatically.
