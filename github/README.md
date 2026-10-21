# posthole data

Written by the posthole extension: every post you scrolled past on X, LinkedIn, Bluesky,
Threads and Hacker News, with its media, as `posthole.post/1` records. Posts are keyed and
foldered like reacji.to (`x/<id>`, `linkedin/<id>`, `web/<sha256 of the canonical URL>`).

- `index/YYYY-MM-DD.jsonl` — every capture, in order
- `<x|linkedin|web>/<id>/post.json` — the record; `source.json` the site's own data; media beside it
- `raw/` — every API response as received (gzipped)
- `.posthole/` — the site builder and indexer the workflow runs (kept in sync by the extension)

The `posthole site` workflow runs every 15 minutes. It appends the posts saved since its last
run to the card site, adds them to `posthole.sqlite` (full text and embeddings), and publishes
to GitHub Pages. Built files live on the `posthole-site` branch as a single commit.

Files over 100 MB (long videos) are listed in `.gitignore` and stay on the computer that saved them.
