# posthole record schema (`posthole.post/1`)

Every post from every site is saved in the same shape, identified exactly as reacji.to identifies posts, so saved posts and reactions join on the same key:

| Post | Key | Folder |
| --- | --- | --- |
| X post | `x:<tweet id>` | `x/<tweet id>/` |
| LinkedIn post | `linkedin:<activity id>` | `linkedin/<activity id>/` |
| Anything else: Bluesky, Threads, Hacker News, LinkedIn comments | `web:<sha256 of the canonical post URL>` | `web/<sha256>/` |

The canonical URL follows reacji.to's `canonicalUrl`: tracking parameters (`utm_*`, `fbclid`, `gclid`) and plain `#fragments` are dropped.

```
<save folder>/
  <x|linkedin|web>/<id>/post.json     the record below
  <x|linkedin|web>/<id>/source.json   the site's own data for the post, untouched
  <x|linkedin|web>/<id>/01.jpg        media, numbered in order (01-thumb.jpg = video poster, card.jpg = link preview image)
  <x|linkedin|web>/_avatars/<author>-<hash>.jpg
  index/YYYY-MM-DD.jsonl              one line per capture, in the order it happened
  raw/<platform>/YYYY-MM-DD/*.json.gz every API response and page exactly as received
```

`platform` is `x`, `linkedin`, `bluesky`, `threads` or `hackernews`. Seeing a post again updates the same folder. Newer counts replace older ones, but nothing an earlier capture recorded is erased.

## post.json

| Field | Type | Notes |
| --- | --- | --- |
| `schema` | `"posthole.post/1"` | |
| `key` | string | The reacji.to post key (see above) |
| `platform` | string | |
| `id` | string | Native ID: tweet ID, LinkedIn activity ID (comments: `urn:li:comment:(activity:…,…)`), Bluesky `at://` URI, Threads `pk`, HN item ID |
| `url` | string | Canonical permalink |
| `kind` | `post` · `reply` · `quote` · `article` · `story` · `comment` | `article` is an X long-form Article; `story` is a Hacker News story; `comment` is a Hacker News or LinkedIn comment |
| `author` | object | `id`, `handle`, `name`, `url`, `description` (LinkedIn headline), `verified`, `avatar_url`, `avatar_file` |
| `created_at` | ISO 8601 or null | LinkedIn's is decoded from the activity ID |
| `title` | string or null | HN story title, X Article title, LinkedIn document title |
| `text` | string | Plain text with shortened links expanded and trailing media links removed |
| `lang` | string or null | |
| `links` | `[{ url, text }]` | Outbound links in the text |
| `mentions` | `[string]` | Handles (LinkedIn: names) |
| `hashtags` | `[string]` | Without `#` |
| `media` | `[Media]` | See below |
| `link_card` | object or null | `url`, `title`, `description`, `domain`, `image_url`, `image_file`. HN uses this for the story's link. |
| `reply_to` | object or null | `id`, `url`, `author_handle` of the parent |
| `thread_root` | object or null | `id`, `url` of the conversation root, when different from the parent |
| `quote_of` | object or null | `platform`, `id`, `url` of the quoted or reshared post (saved as its own record too) |
| `metrics` | object | `likes`, `reposts`, `quotes`, `replies`, `views`, `bookmarks`, `score` (HN points). Null when the site doesn't show it. |
| `extra` | object | Platform-specific values: X `conversation_id`, `long_post`, `community`; Bluesky `cid`, `labels`; Threads `code`, `shares`; LinkedIn `actor_line` (e.g. "7h • Edited"), `edited`, `permalink`, `comments_request` (the feed's own request for this post's comments), and on Voyager pages `urn`, `share_urn`, `social_detail_urn`; HN `rank`, `depth` |
| `captured` | object | `first_at`, `last_at`, `times_seen`, `first_page` (the page you were on), `endpoint` (the API call, `html`, or `thread:…` when posthole fetched it), `thread_of` (key of the post whose reply thread brought it in, or null if you scrolled past it) |

### Media

| Field | Notes |
| --- | --- |
| `type` | `image`, `video`, `gif` (X's looping MP4s), `document` (LinkedIn PDFs) |
| `url` | Best-quality source URL: X `name=orig` images and the highest-bitrate MP4, Bluesky full-size images, Threads/LinkedIn largest rendition. Bluesky video is fetched as the original MP4 from the author's PDS. |
| `file` | Saved file name relative to the post folder, or null until it has downloaded |
| `mime`, `alt`, `width`, `height`, `duration_ms` | When the site provides them |
| `thumbnail_url`, `thumbnail_file` | Video poster frame |

Signed CDN URLs (Threads, LinkedIn) expire; the saved files don't.

## index/YYYY-MM-DD.jsonl

One line each time a post is captured, or captured again more than 10 minutes later:

```json
{"at":"…","key":"x:…","platform":"x","id":"…","kind":"post","url":"…","author":"ada","created_at":"…","title":null,"text":"first 280 characters","path":"x/1849…/post.json","page":"https://x.com/home","reposted_by":"grace","new":true}
```

`reposted_by` appears when the post reached your timeline as someone else's repost. Reposts themselves are not saved as separate posts. `thread_of` appears on posts that posthole fetched as part of another post's reply thread.

## raw/

Each file is one gzipped JSON object: `captured_at`, `page` (the tab's URL), `via` (`fetch`, `xhr`, `document` for page HTML, or `posthole` for thread fetches), `url`, `method`, `status`, `contentType`, `requestBody`, `body` (the response exactly as received; `encoding: "base64"` for binary), and `expand` for thread fetches. Re-running the parsers over `raw/` reproduces every `post.json`.

## posthole.sqlite

Built by the GitHub workflow (`.posthole/embed.py`) and attached to the repository's `posthole-index` release.

- `posts`: one row per saved post: `key` (reacji.to key), platform, id, url, kind, author, `created_at`, `first_seen_at`, `last_seen_at`, `seen` (1 if you scrolled past it, 0 if it came from a reply thread), `thread_of`, `reply_to`, `quote_of`, title, text, link, counts, and `path` to its `post.json`
- `posts_fts`: FTS5 full-text index over title, text and author (`rowid` = `posts.rowid`)
- `post_vectors`: sqlite-vec embeddings, cosine distance (`rowid` = `posts.rowid`); the model and dimension are in `meta`. The default model is [`microsoft/harrier-oss-v1-270m`](https://huggingface.co/microsoft/harrier-oss-v1-270m) (640 dimensions, MIT). Posts are embedded without a prefix; embed a search query with `prompt_name="web_search_query"`:

```python
q = SentenceTransformer("microsoft/harrier-oss-v1-270m").encode("rust async runtimes", prompt_name="web_search_query", normalize_embeddings=True)
db.execute("SELECT p.key, p.text, v.distance FROM post_vectors v JOIN posts p ON p.rowid = v.rowid WHERE v.embedding MATCH ? AND k = 20 ORDER BY v.distance", (sqlite_vec.serialize_float32(q.tolist()),))
```
