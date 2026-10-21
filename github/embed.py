"""Indexes saved posts into SQLite: one row per post (keyed like reacji.to), full-text
search, and an embedding per post for semantic search.

    python embed.py --dir <data repository> --db posthole.sqlite

Incremental: only posts captured since the last run are read, and only posts whose
text changed are embedded again. Query example:

    SELECT p.key, p.text, v.distance
    FROM post_vectors v JOIN posts p ON p.rowid = v.rowid
    WHERE v.embedding MATCH :query_vector AND k = 20 ORDER BY v.distance;
"""
import argparse
import glob
import hashlib
import json
import os
import sqlite3
import time

import sqlite_vec

# microsoft/harrier-oss-v1-270m (MIT, March 2026): the strongest small open embedding model on
# MMTEB at this size, and fast enough for a CPU runner. Documents need no prefix; encode
# search queries with prompt_name="web_search_query" (or "sts_query" to find similar posts).
MODEL = os.environ.get('POSTHOLE_EMBED_MODEL', 'microsoft/harrier-oss-v1-270m')
DIM = int(os.environ.get('POSTHOLE_EMBED_DIM', '640'))
MAX_TOKENS = 512
# Runners are slow (2 vCPU for private repositories): embed newest posts first within a time
# budget, saving after every batch; the backlog continues on the next run.
BUDGET_SECONDS = int(os.environ.get('POSTHOLE_EMBED_BUDGET', '600'))
SCHEMA_VERSION = '1'
BATCH = 32


def connect(path):
    db = sqlite3.connect(path)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.executescript(f"""
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS posts (
      rowid INTEGER PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,          -- reacji.to post key: x:<id>, linkedin:<id>, web:<sha256>
      platform TEXT, id TEXT, url TEXT, kind TEXT,
      author_handle TEXT, author_name TEXT,
      created_at TEXT,
      first_seen_at TEXT, last_seen_at TEXT,
      seen INTEGER,                      -- 1: you scrolled past it; 0: fetched as part of a reply thread
      thread_of TEXT, reply_to TEXT, quote_of TEXT,
      title TEXT, text TEXT, link_url TEXT,
      likes INTEGER, replies INTEGER, reposts INTEGER, views INTEGER, score INTEGER,
      media INTEGER,
      path TEXT,                         -- post.json in the data repository
      embed_text TEXT,                   -- what gets embedded (author, title, text, link title)
      embed_hash TEXT,
      embedded_hash TEXT                 -- embed_hash when the vector was written; differs = pending
    );
    CREATE INDEX IF NOT EXISTS posts_seen ON posts (first_seen_at);
    CREATE INDEX IF NOT EXISTS posts_thread ON posts (thread_of);
    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5 (key UNINDEXED, title, text, author, tokenize = 'unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS post_vectors USING vec0 (embedding float[{DIM}] distance_metric=cosine);
    """)
    for column in ('embed_text TEXT', 'embed_hash TEXT'):
        try:
            db.execute(f'ALTER TABLE posts ADD COLUMN {column}')
        except sqlite3.OperationalError:
            pass
    stored = dict(db.execute('SELECT key, value FROM meta'))
    if stored.get('model') and (stored['model'] != MODEL or stored.get('dim') != str(DIM)):
        # A different model's vectors aren't comparable: start the vectors over.
        db.executescript(f"DROP TABLE post_vectors; CREATE VIRTUAL TABLE post_vectors USING vec0 (embedding float[{DIM}] distance_metric=cosine); UPDATE posts SET embedded_hash = NULL;")
        stored['last_index_at'] = ''
    db.executemany('INSERT OR REPLACE INTO meta VALUES (?, ?)', [('model', MODEL), ('dim', str(DIM)), ('schema', SCHEMA_VERSION)])
    return db, stored.get('last_index_at', '')


def sightings(root, since):
    """Index lines newer than `since`, merged per post key."""
    merged = {}
    newest = since
    for file in sorted(glob.glob(os.path.join(root, 'index', '*.jsonl'))):
        with open(file, encoding='utf-8') as handle:
            for line in handle:
                try:
                    s = json.loads(line)
                except ValueError:
                    continue
                at = s.get('at') or ''
                if at <= since:
                    continue
                newest = max(newest, at)
                key = s.get('key') or f"{s['platform']}:{s['id']}"
                m = merged.setdefault(key, {'path': s['path'], 'first': at, 'last': at, 'seen': False, 'thread_of': None})
                m['first'], m['last'] = min(m['first'], at), max(m['last'], at)
                if s.get('thread_of'):
                    m['thread_of'] = m['thread_of'] or s['thread_of']
                else:
                    m['seen'] = True
    return merged, newest


def document(record):
    """What gets embedded: who said it, and what they said (including a link's title)."""
    author = record.get('author') or {}
    who = ' '.join(filter(None, [author.get('name'), f"(@{author['handle']})" if author.get('handle') else None]))
    card = record.get('link_card') or {}
    parts = [who, record.get('title'), record.get('text'), card.get('title'), card.get('description')]
    return '\n'.join(p.strip() for p in parts if p and p.strip())[:4000]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True)
    parser.add_argument('--db', required=True)
    args = parser.parse_args()
    db, since = connect(args.db)
    merged, newest = sightings(args.dir, since)
    for key, m in merged.items():
        try:
            with open(os.path.join(args.dir, m['path']), encoding='utf-8') as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            continue
        author = record.get('author') or {}
        metrics = record.get('metrics') or {}
        row = db.execute('SELECT rowid, first_seen_at, seen, thread_of FROM posts WHERE key = ?', (key,)).fetchone()
        first_seen = min(filter(None, [m['first'], row[1] if row else None]))
        seen = int(m['seen'] or bool(row and row[2]))
        values = dict(
            key=key, platform=record.get('platform'), id=str(record.get('id')), url=record.get('url'), kind=record.get('kind'),
            author_handle=author.get('handle'), author_name=author.get('name'), created_at=record.get('created_at'),
            first_seen_at=first_seen, last_seen_at=m['last'], seen=seen,
            thread_of=(row[3] if row and row[3] else m['thread_of']) if not seen else None,
            reply_to=(record.get('reply_to') or {}).get('id'), quote_of=(record.get('quote_of') or {}).get('id'),
            title=record.get('title'), text=record.get('text'), link_url=(record.get('link_card') or {}).get('url'),
            likes=metrics.get('likes'), replies=metrics.get('replies'), reposts=metrics.get('reposts'), views=metrics.get('views'), score=metrics.get('score'),
            media=len(record.get('media') or []), path=m['path'],
        )
        columns = ', '.join(values)
        db.execute(f"INSERT INTO posts ({columns}) VALUES ({', '.join('?' for _ in values)}) "
                   f"ON CONFLICT(key) DO UPDATE SET {', '.join(f'{c} = excluded.{c}' for c in values if c != 'key')}", list(values.values()))
        rowid = db.execute('SELECT rowid FROM posts WHERE key = ?', (key,)).fetchone()[0]
        db.execute('DELETE FROM posts_fts WHERE rowid = ?', (rowid,))
        db.execute('INSERT INTO posts_fts (rowid, key, title, text, author) VALUES (?, ?, ?, ?, ?)',
                   (rowid, key, values['title'] or '', values['text'] or '', ' '.join(filter(None, [values['author_name'], values['author_handle']]))))
        text = document(record)
        db.execute('UPDATE posts SET embed_text = ?, embed_hash = ? WHERE rowid = ?', (text, hashlib.sha256(text.encode('utf-8')).hexdigest() if text else None, rowid))
    db.commit()

    # Everything not yet embedded with its current text, newest first (earlier runs' backlog included).
    pending = db.execute("""SELECT rowid, embed_text, embed_hash FROM posts
                            WHERE embed_hash IS NOT NULL AND (embedded_hash IS NULL OR embedded_hash != embed_hash)
                            ORDER BY first_seen_at DESC""").fetchall()
    done = 0
    if pending:
        from sentence_transformers import SentenceTransformer
        started = time.time()
        import torch
        # Force fp32: the checkpoint is bf16, which transformers now loads as-is, and bf16 matmuls
        # on CPUs without native support are many times slower (5x even on Apple silicon).
        model = SentenceTransformer(MODEL, device='cpu', truncate_dim=DIM, model_kwargs={'dtype': torch.float32})
        model.max_seq_length = MAX_TOKENS
        for i in range(0, len(pending), 128):
            if time.time() - started > BUDGET_SECONDS:
                break
            chunk = pending[i:i + 128]
            # sentence-transformers sorts each call by length, so short posts aren't padded to long ones.
            vectors = model.encode([t for _, t, _ in chunk], normalize_embeddings=True, batch_size=BATCH)
            for (rowid, _, digest), vector in zip(chunk, vectors):
                db.execute('DELETE FROM post_vectors WHERE rowid = ?', (rowid,))
                db.execute('INSERT INTO post_vectors (rowid, embedding) VALUES (?, ?)', (rowid, sqlite_vec.serialize_float32(vector.tolist())))
                db.execute('UPDATE posts SET embedded_hash = ? WHERE rowid = ?', (digest, rowid))
            db.commit()
            done += len(chunk)
        rate = done / max(time.time() - started, 1)
        print(f'Embedded {done} of {len(pending)} pending posts with {MODEL} ({rate:.1f}/s); {len(pending) - done} left for the next run')
    db.executemany('INSERT OR REPLACE INTO meta VALUES (?, ?)', [('last_index_at', newest), ('updated_at', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))])
    db.commit()
    total = db.execute('SELECT count(*) FROM posts').fetchone()[0]
    print(f'{len(merged)} posts indexed this run, {total} in {args.db}')


if __name__ == '__main__':
    main()
