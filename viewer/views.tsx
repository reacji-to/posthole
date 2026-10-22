/** @jsxImportSource hono/jsx */
import path from 'node:path';
import type { Child } from 'hono/jsx';
import type { Media, Post, Sighting } from './store';
import { Icon } from './icons';
import { INTERFACES, interfaceOf, isPlayer, type Interface } from './interfaces';

export const PLATFORMS: Record<string, { label: string; short: string }> = {
  x: { label: 'X', short: 'X' },
  linkedin: { label: 'LinkedIn', short: 'in' },
  bluesky: { label: 'Bluesky', short: 'bsky' },
  threads: { label: 'Threads', short: '@' },
  hackernews: { label: 'Hacker News', short: 'Y' },
};

// ---- formatting --------------------------------------------------------------------

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const dayTime = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
const clock = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });

function ago(iso: string | null, now = Date.now()) {
  if (!iso) return '';
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return dateOnly.format(new Date(iso));
}

// Where saved files are served from: the local server's /files/, a public mirror of the
// data repository, or null to use the sites' original URLs. `resolve`, when set, decides
// per file (the static site copies the images it shows) and returns null to fall back.
export type FileKind = 'image' | 'avatar' | 'video';
export const files: { base: string | null; resolve?: (rel: string, kind: FileKind) => string | null } = { base: '/files/' };

// Saved files are addressed relative to the post's folder; avatars live one level up.
const relative = (folder: string, file: string) => path.posix.normalize(path.posix.join(folder, file));
export const fileHref = (folder: string, file: string) => `${files.base}${relative(folder, file).split('/').map(encodeURIComponent).join('/')}`;
function source(folder: string, file: string | null, url: string | null, kind: FileKind = 'image') {
  if (!file) return url ?? undefined;
  if (files.resolve) return files.resolve(relative(folder, file), kind) ?? url ?? undefined;
  return files.base !== null ? fileHref(folder, file) : url ?? undefined;
}

function Linked({ text, post }: { text: string; post: Post }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]']|@[\w.]+|#[\p{L}\p{N}_]+)/gu);
  return <>{parts.map(part => {
    let href: string | undefined;
    let label = part;
    if (/^https?:/.test(part)) {
      href = part;
      label = post.links.find(link => link.url === part)?.text || part.replace(/^https?:\/\/(www\.)?/, '');
    } else if (part.startsWith('@') && post.platform === 'x') href = `https://x.com/${part.slice(1)}`;
    else if (part.startsWith('#') && post.platform === 'x') href = `https://x.com/hashtag/${encodeURIComponent(part.slice(1))}`;
    return href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : part;
  })}</>;
}

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

type Display = { preview_text?: string | null; verified_type?: string | null; liked?: boolean; reposted?: boolean; bookmarked?: boolean };
const displayOf = (post: Post) => (post.extra.display ?? {}) as Display;

// Freeze source ages at the last saved observation, alongside the saved counts.
function PostTime({ post }: { post: Post }) {
  const reference = Date.parse(post.captured?.last_at ?? post.created_at ?? '');
  const created = new Date(post.created_at ?? '');
  const oldX = post.platform === 'x' && reference - created.getTime() >= 86400000;
  const label = post.platform === 'linkedin' && typeof post.extra.actor_line === 'string'
    ? post.extra.actor_line : oldX
      ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(created.getFullYear() !== new Date(reference).getFullYear() ? { year: 'numeric' as const } : {}) }).format(created)
      : ago(post.created_at, reference);
  return <a class="when" href={post.url} target="_blank" rel="noreferrer" title={post.created_at ?? ''}>
    <time datetime={post.created_at ?? undefined}>{label}</time>
  </a>;
}

// ---- pieces --------------------------------------------------------------------------

function Avatar({ post, folder }: { post: Post; folder: string }) {
  const src = source(folder, post.author.avatar_file, post.author.avatar_url, 'avatar');
  const initial = (post.author.name ?? post.author.handle ?? '?').trim().charAt(0).toUpperCase();
  return src ? <img class="avatar" src={src} alt="" loading="lazy" decoding="async" /> : <span class="avatar placeholder">{initial}</span>;
}

function Gallery({ media, folder }: { media: Media[]; folder: string }) {
  const visual = media.filter(m => m.type !== 'document');
  if (!visual.length) return null;
  return (
    <div class={`gallery n${Math.min(visual.length, 4)}`}>
      {visual.map(m => {
        const src = source(folder, m.file, m.url, m.type === 'video' || m.type === 'gif' ? 'video' : 'image');
        const poster = source(folder, m.thumbnail_file, m.thumbnail_url);
        if (m.type === 'video' || m.type === 'gif') {
          return (
            <video controls={m.type === 'video'} autoplay={m.type === 'gif'} loop={m.type === 'gif'} muted={m.type === 'gif'} playsinline preload="none"
              poster={poster} src={src} width={m.width ?? undefined} height={m.height ?? undefined} />
          );
        }
        return (
          <a href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={m.alt ?? ''} loading="lazy" decoding="async" width={m.width ?? undefined} height={m.height ?? undefined} />
          </a>
        );
      })}
    </div>
  );
}

function LinkCard({ post, folder }: { post: Post; folder: string }) {
  const card = post.link_card;
  if (!card?.url) return null;
  const image = source(folder, card.image_file, card.image_url);
  return (
    <a class={`linkcard${image ? '' : ' bare'}`} href={card.url} target="_blank" rel="noreferrer">
      {image && <img src={image} alt="" loading="lazy" decoding="async" />}
      <span class="linkcard-text">
        <span class="domain">{card.domain ?? host(card.url)}</span>
        {card.title && <span class="linkcard-title">{card.title}</span>}
        {card.description && <span class="linkcard-desc">{card.description}</span>}
      </span>
    </a>
  );
}

function Actions({ post }: { post: Post }) {
  const m = post.metrics;
  const display = displayOf(post);
  const li = post.platform === 'linkedin';
  const threads = post.platform === 'threads';
  const actions = li
    ? [['li-like', 'reactions', m.likes, display.liked], ['li-comment', 'comments', m.replies], ['li-repost', 'reposts', m.reposts], ['li-send', 'Send', null]]
    : threads
      ? [['heart', 'likes', m.likes], ['reply', 'replies', m.replies], ['repost', 'reposts', m.reposts], ['li-send', 'Share', null]]
      : [['reply', 'replies', m.replies], ['repost', 'reposts', m.reposts, display.reposted], ['heart', 'likes', m.likes, display.liked], ...(post.platform === 'x' ? [['views', 'views', m.views], ['bookmark', 'Bookmark', null, display.bookmarked], ['share', 'Share', null]] : [['share', 'Share', null]])];
  return <footer class="actions" aria-label="Saved engagement">
    {actions.map(([icon, label, count, active]) => <a class={`action ${icon}${active ? ' active' : ''}`} href={post.url} target="_blank" rel="noreferrer"
      aria-label={`${typeof count === 'number' ? `${count} ` : ''}${label} · open original post`} title={`Open on ${PLATFORMS[post.platform]?.label}`}>
      <Icon name={String(icon)} />{typeof count === 'number' && count > 0 && <span>{compact.format(count)}</span>}
    </a>)}
  </footer>;
}

function Header({ post, folder, quote = false }: { post: Post; folder: string; quote?: boolean }) {
  const li = post.platform === 'linkedin';
  const threads = post.platform === 'threads';
  const handle = post.author.handle && !li && !threads ? `@${post.author.handle}` : null;
  return <header class="head">
    <a class="avatar-link" href={post.author.url ?? post.url} target="_blank" rel="noreferrer"><Avatar post={post} folder={folder} /></a>
    <div class="who">
      <div class="line1">
        <a class="name" href={post.author.url ?? post.url} target="_blank" rel="noreferrer">{threads ? post.author.handle ?? post.author.name : post.author.name ?? post.author.handle ?? 'Unknown'}</a>
        {post.author.verified && <span class={`verified ${displayOf(post).verified_type ?? ''}`} title="Verified"><Icon name="verified" /></span>}
        {handle && <span class="handle">{handle}</span>}
        {!li && <><span class="dot">·</span><PostTime post={post} /></>}
      </div>
      {li && post.author.description && <div class="headline">{post.author.description}</div>}
      {li && <PostTime post={post} />}
    </div>
    {!quote && <div class="head-actions">
      {post.platform === 'x' && <a href={post.url} target="_blank" rel="noreferrer" aria-label="Open Grok actions on X"><Icon name="grok" /></a>}
      <a href={post.url} target="_blank" rel="noreferrer" aria-label="More on original post"><Icon name="more" /></a>
    </div>}
  </header>;
}

function Copy({ post, expandable = false }: { post: Post; expandable?: boolean }) {
  if (!post.text) return null;
  const preview = displayOf(post).preview_text;
  const truncated = post.platform === 'x' && preview && preview !== post.text;
  const clamp = (post.platform === 'linkedin' || expandable) && post.text.length > 180;
  return <div class={`copy${clamp ? ' clamp' : ''}`}>
    <p class="text" dir="auto" data-preview>{<Linked text={truncated ? preview : post.text} post={post} />}</p>
    {truncated && <p class="text" dir="auto" data-full hidden><Linked text={post.text} post={post} /></p>}
    {(truncated || clamp) && <button type="button" class="expand-text" aria-expanded="false">{post.platform === 'linkedin' ? '… more' : 'Show more'}</button>}
  </div>;
}

function Body({ post, folder, expandable = false }: { post: Post; folder: string; expandable?: boolean }) {
  return <>
    {post.title && <h3 class="title">{post.title}</h3>}
    <Copy post={post} expandable={expandable} />
    <Gallery media={post.media} folder={folder} />
    <LinkCard post={post} folder={folder} />
    {post.media.filter(m => m.type === 'document').map(m => <a class="doc" href={source(folder, m.file, m.url)} target="_blank" rel="noreferrer">View document</a>)}
  </>;
}

// ---- cards ----------------------------------------------------------------------------

export type CardData = { post: Post; folder: string; sighting?: Sighting; quoted?: { post: Post; folder: string } | null; saved: number; key: string; archiveKey?: string; repliesHref?: string | null; view?: Interface };

// Alternative interfaces keep the real source identity and links. Nothing here
// changes a post's platform or pretends its saved engagement belongs to another site.
function InterfaceCard({ post, folder, quoted, saved, archiveKey, repliesHref, view }: CardData) {
  const key = archiveKey ?? post.key ?? `${post.platform}:${post.id}`;
  const label = post.title || post.text.split('\n').find(Boolean) || post.link_card?.title || 'Media post';
  const visualPost = post.media.some(m => m.type !== 'document') ? { post, folder } : quoted ?? { post, folder };
  const cover = visualPost.post.media.find(m => m.type === 'video' || m.type === 'gif') ?? visualPost.post.media.find(m => m.type === 'image');
  const video = cover?.type === 'video' || cover?.type === 'gif';
  const poster = cover ? source(visualPost.folder, video ? cover.thumbnail_file : cover.file, video ? cover.thumbnail_url : cover.url) : source(folder, post.link_card?.image_file ?? null, post.link_card?.image_url ?? null);
  const byline = <div class="interface-author"><Avatar post={post} folder={folder} /><div><a class="interface-name" href={post.author.url ?? post.url} target="_blank" rel="noreferrer">{post.author.name || post.author.handle || 'Unknown'}</a><span>{PLATFORMS[post.platform]?.label ?? post.platform}{post.created_at && <> · {dateOnly.format(new Date(post.created_at))}</>}</span></div><a class="original-link" href={post.url} target="_blank" rel="noreferrer">Original ↗</a></div>;
  const content = <div class="interface-content"><Body post={post} folder={folder} expandable />
    {quoted && <blockquote class="interface-quote"><strong>{quoted.post.author.name || quoted.post.author.handle}</strong><Body post={quoted.post} folder={quoted.folder} expandable /></blockquote>}
    {post.quote_of && !quoted && <a href={post.quote_of.url} target="_blank" rel="noreferrer">View quoted post ↗</a>}
  </div>;
  return <section class={`post-entry interface-entry${view === 'netflix' ? ' netflix-entry' : ''}`} data-key={key} data-title={label.slice(0, 160)} data-source={post.platform} data-creator={post.author.name || post.author.handle || 'Unknown'} data-media-kind={video ? 'video' : poster ? 'image' : 'text'}>
    {view === 'netflix' && <button type="button" class="nf-tile" data-open-post={key} aria-label={`Open post by ${post.author.name || post.author.handle}: ${label.slice(0, 100)}`}>
      <span class="nf-cover">{poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <span class="nf-type-cover">{label.slice(0, 160)}</span>}<span class="nf-badge">{video ? 'VIDEO' : 'POST'}</span><span class="nf-tile-play" aria-hidden="true">{video ? <svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z" fill="currentColor"/></svg> : <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>}</span></span>
      <span class="nf-tile-title">{label.slice(0, 110)}</span><span class="nf-tile-byline">{post.author.name || post.author.handle} · {PLATFORMS[post.platform]?.label}</span>
    </button>}
    <article class="interface-card" aria-label={`${PLATFORMS[post.platform]?.label ?? post.platform} post by ${post.author.name || post.author.handle}`}>
      {view === 'hackernews' ? <><div class="story-heading"><span class="story-rank" /><details><summary>{label.slice(0, 220)}{label.length > 220 ? '…' : ''}<span class="story-domain"> ({host(post.url)})</span></summary>{byline}{content}</details></div><div class="story-meta">{post.metrics.score ?? post.metrics.likes ?? 0} {post.metrics.score != null ? 'points' : 'likes'} by {post.author.name || post.author.handle} · {PLATFORMS[post.platform]?.label} · <a href={post.url} target="_blank" rel="noreferrer">original</a></div></> : <>{byline}{content}</>}
      <div class="interface-bottom">
        {view !== 'hackernews' && <span>{post.metrics.likes != null ? `${compact.format(post.metrics.likes)} likes` : 'Saved post'}{post.metrics.replies != null ? ` · ${compact.format(post.metrics.replies)} replies` : ''}</span>}
        {saved > 0 && <button class="replies-toggle" aria-expanded="false" data-href={repliesHref ?? `/replies?key=${encodeURIComponent(key)}&view=${view}`}>Show {saved} saved replies</button>}
        {saved > 0 && <div class="replies" hidden />}
      </div>
    </article>
  </section>;
}

function HNCard({ post }: { post: Post }) {
  const story = post.kind === 'story';
  return <div class={`hn-item ${story ? 'story' : 'comment'}`}>
    {story && <span class="rank">{typeof post.extra.rank === 'number' ? `${post.extra.rank}.` : ''}</span>}
    <a class="hn-vote" href={post.url} target="_blank" rel="noreferrer" aria-label="Vote on Hacker News"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 8 5 0l5 8z" fill="currentColor" /></svg></a>
    <div>
      {story && <div class="hn-title"><a href={post.link_card?.url ?? post.url} target="_blank" rel="noreferrer">{post.title}</a>{post.link_card?.url && <span class="domain"> ({post.link_card.domain ?? host(post.link_card.url)})</span>}</div>}
      <div class="hn-meta">{story && post.metrics.score != null && `${post.metrics.score} points by `}<a href={post.author.url ?? post.url} target="_blank" rel="noreferrer">{post.author.handle ?? post.author.name}</a> <PostTime post={post} />{story && <> | <a href={post.url} target="_blank" rel="noreferrer">{post.metrics.replies ? `${post.metrics.replies} comments` : 'discuss'}</a></>}</div>
      {post.text && <p class="text"><Linked text={post.text} post={post} /></p>}
    </div>
  </div>;
}

export function Card({ post, folder, sighting, quoted, saved, archiveKey, repliesHref, view = 'original' }: CardData) {
  const key = archiveKey ?? post.key ?? `${post.platform}:${post.id}`;
  if (view !== 'original') return <InterfaceCard {...{ post, folder, sighting, quoted, saved, key, archiveKey: key, repliesHref, view }} />;
  const replyingTo = post.reply_to?.author_handle;
  return <section class={`post-entry ${post.platform}`} data-key={key}>
    <article class={`card ${post.platform}`} aria-label={`${PLATFORMS[post.platform]?.label ?? post.platform} post by ${post.author.name ?? post.author.handle}`}>
      {post.platform === 'hackernews' ? <HNCard post={post} /> : <>
        {sighting?.reposted_by && <div class="context"><Icon name="repost" />{sighting.reposted_by} reposted</div>}
        <Header post={post} folder={folder} />
        <div class="post-content">
          {replyingTo && post.kind === 'reply' && <div class="reply-context">Replying to <a href={post.reply_to?.url ?? post.url}>@{replyingTo}</a></div>}
          <Body post={post} folder={folder} />
          {quoted && <div class={`quoted ${quoted.post.platform}${post.platform === 'x' && post.media.length > 0 && quoted.post.media.length > 0 ? ' condensed' : ''}`}>
            <Header post={quoted.post} folder={quoted.folder} quote />
            <div class="quote-body"><Body post={quoted.post} folder={quoted.folder} /></div>
          </div>}
          {post.quote_of && !quoted && <a class="quoted missing" href={post.quote_of.url} target="_blank" rel="noreferrer">View quoted post</a>}
          <Actions post={post} />
        </div>
      </>}
    </article>
    {(sighting || saved > 0) && <div class="archive-tools">
      {sighting && <span class="seen" title={dayTime.format(new Date(sighting.at))}>{PLATFORMS[post.platform]?.label} · seen <time datetime={sighting.at} data-format="clock">{clock.format(new Date(sighting.at))}</time></span>}
      {saved > 0 && <button class="replies-toggle" aria-expanded="false" data-href={repliesHref ?? `/replies?key=${encodeURIComponent(key)}`}>
        Show {saved} saved {saved === 1 ? (post.platform === 'hackernews' ? 'comment' : 'reply') : (post.platform === 'hackernews' ? 'comments' : 'replies')}
      </button>}
      <div class="replies" hidden />
    </div>}
  </section>;
}

// A new session starts after a gap; the divider says when and where you were.
export function Divider({ sighting }: { sighting: Sighting }) {
  let where = '';
  try { const u = new URL(sighting.page ?? ''); where = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`; } catch { /* no page */ }
  return <div class="divider"><span><time datetime={sighting.at} data-format="daytime">{dayTime.format(new Date(sighting.at))}</time>{where ? ` · ${where}` : ''}</span></div>;
}

export type ReplyNode = { data: CardData; children: ReplyNode[] };

export function ReplyTree({ nodes, depth = 0, view = 'original' }: { nodes: ReplyNode[]; depth?: number; view?: Interface }): Child {
  return (
    <ol class="tree" data-depth={depth}>
      {nodes.map(node => (
        <li>
          <Card {...node.data} archiveKey={node.data.key} saved={0} view={view} />
          {node.children.length > 0 && <ReplyTree nodes={node.children} depth={depth + 1} view={view} />}
        </li>
      ))}
    </ol>
  );
}

// ---- page --------------------------------------------------------------------------------

export function Page({ children, counts, total, query }: { children: Child; counts: Record<string, number>; total: number; query: URLSearchParams }) {
  const view = interfaceOf(query.get('view'));
  const player = isPlayer(view);
  const title = player ? INTERFACES[view].label : view === 'netflix' ? 'Postflix' : 'posthole';
  const feed = <main class="feed" tabindex={player ? 0 : undefined} aria-label="Saved posts">{children}</main>;
  const active = new Set(query.getAll('p'));
  const order = query.get('order') === 'recent' ? 'recent' : 'seen';
  const href = (change: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams(query);
    change(q);
    const s = q.toString();
    return s ? `/?${s}` : '/';
  };
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title === 'posthole' ? title : `${title} — posthole`}</title>
        <link rel="icon" href="/icon.png" />
        <link rel="stylesheet" href="/style.css" />
        <link rel="stylesheet" href="/interfaces.css" />
        {view === 'netflix' && <link rel="stylesheet" href="/netflix.css" />}
      </head>
      <body data-view={view}>
        {view === 'ipod' && <svg width="0" height="0" aria-hidden="true" style="position:absolute" focusable="false">
          <defs><filter id="postpod-monochrome" color-interpolation-filters="sRGB">
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncR type="discrete" tableValues="0 1" />
              <feFuncG type="discrete" tableValues="0 1" />
              <feFuncB type="discrete" tableValues="0 1" />
            </feComponentTransfer>
          </filter></defs>
        </svg>}
        <nav class="bar">
          <a class="brand" href="/"><img src="/icon.png" alt="" />{player ? 'Postpod' : view === 'netflix' ? 'Postflix' : 'posthole'}</a>
          <div class="filters">
            <a class={active.size ? 'chip' : 'chip on'} href={href(q => q.delete('p'))}>All <b>{total}</b></a>
            {Object.entries(PLATFORMS).filter(([p]) => counts[p]).map(([p, info]) => (
              <a class={active.has(p) ? 'chip on' : 'chip'} href={href(q => { q.delete('p'); if (!active.has(p)) q.append('p', p); })}>{info.label} <b>{counts[p]}</b></a>
            ))}
          </div>
          <form class="search" action="/">
            <input type="hidden" name="view" value={view} />
            {[...active].map(p => <input type="hidden" name="p" value={p} />)}
            {order === 'recent' && <input type="hidden" name="order" value="recent" />}
            <input type="search" name="q" value={query.get('q') ?? ''} placeholder="Search" aria-label="Search posts" />
          </form>
          <a class="chip order" href={href(q => (order === 'recent' ? q.delete('order') : q.set('order', 'recent')))}>
            {order === 'recent' ? 'Newest first' : 'In order seen'}
          </a>
        </nav>
        <div class="interface-toolbar"><form action="/" class="interface-picker">
          {[...query].filter(([key]) => key !== 'view').map(([key, value]) => <input type="hidden" name={key} value={value} />)}
          <label for="interface-select">Interface</label><select id="interface-select" name="view" aria-label="Interface">{Object.entries(INTERFACES).map(([id, info]) => <option value={id} selected={id === view}>{info.label}</option>)}</select><button class="apply-view" type="submit">Switch</button>
        </form>{INTERFACES[view].description && <span class="interface-description">{INTERFACES[view].description}</span>}{view === 'tinder' && <button class="kept-filter" aria-pressed="false">Kept posts <b data-kept-count>0</b></button>}</div>
        <div class="viewer-layout">
          {(view === 'x' || view === 'linkedin') && <aside class="feed-sidebar"><strong>{view === 'x' ? 'Your timeline.' : 'Your reading room.'}</strong><p>Everything you saved.<br />In a different light.</p><a href={href(q => { q.delete('p'); q.delete('q'); })}>All posts</a><span>posthole / {INTERFACES[view].label}</span></aside>}
          {view === 'hackernews' && <div class="hn-masthead"><b>p</b><strong>Posthole News</strong><span>your saved internet</span></div>}
          <div class={player ? 'ipod-shell' : view === 'tinder' ? 'swipe-shell' : 'feed-shell'}>
            {view === 'tinder' && <div class="swipe-heading"><strong>A good post is worth keeping.</strong><span data-position /></div>}
            {player ? <div class="ipod-screen">
              <div class="ipod-top"><strong data-player-title>Postpod</strong><span data-position>Now reading</span><svg viewBox="0 0 28 14" width="26" height="14" aria-label="Archive available"><rect x="1" y="1" width="22" height="12" rx="2" fill="none" stroke="currentColor"/><path d="M24 4h3v6h-3zM4 4h16v6H4z" fill="currentColor"/></svg></div>
              {feed}
              <div class="ipod-list" id="postpod-posts" tabindex="0" hidden aria-label="Posts" />
            </div> : feed}
            {player && <div class="click-wheel" aria-label="Archive click wheel">
              <button class="wheel-menu" data-deck="menu" aria-label="Show post list" aria-controls="postpod-posts" aria-expanded="false">MENU</button>
              <button class="wheel-prev" data-deck="previous" aria-label="Previous post"><Transport direction="previous" /></button>
              <button class="wheel-center" data-deck="select" aria-label="Read selected post" />
              <button class="wheel-next" data-deck="next" aria-label="Next post"><Transport direction="next" /></button>
              <button class="wheel-play" data-deck="play" aria-label="Play or pause media"><svg viewBox="0 0 24 24"><path d="m4 5 9 7-9 7zM17 5v14M21 5v14" fill="currentColor" stroke="currentColor" stroke-width="2" /></svg></button>
            </div>}
            {view === 'tinder' && <div class="swipe-controls"><button data-deck="previous" aria-label="Previous post"><svg viewBox="0 0 24 24"><path d="M9 5 3 11l6 6M3 11h11a7 7 0 0 1 7 7" /></svg></button><button data-deck="next" class="skip-post" aria-label="Skip post"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button><button data-deck="keep" class="keep-post" aria-label="Keep post"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg></button></div>}
          </div>
          {(player || view === 'tinder') && <p class="deck-status" role="status" aria-live="polite" />}
        </div>
        <script src="/client.js" type="module" />
      </body>
    </html>
  );
}

function Transport({ direction }: { direction: 'previous' | 'next' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={direction === 'previous' ? 'transform:rotate(180deg)' : ''}><path d="m3 5 9 7-9 7zm9 0 9 7-9 7z" fill="currentColor" /></svg>;
}

// The static site's shell: cards arrive as chunk files listed in chunks.json.
export function StaticPage({ total, updatedAt, dbUrl }: { total: number; updatedAt?: string; dbUrl?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>posthole</title>
        <link rel="icon" href="icon.png" />
        <link rel="stylesheet" href="style.css" />
      </head>
      <body>
        <nav class="bar">
          <a class="brand" href="./"><img src="icon.png" alt="" />posthole</a>
          <div class="filters">
            <span class="chip on">All <b>{total}</b></span>
            {updatedAt && <span class="chip">updated <time datetime={updatedAt} data-format="daytime">{dayTime.format(new Date(updatedAt))}</time></span>}
          </div>
          {dbUrl && <a class="chip db" href={dbUrl}>posthole.sqlite</a>}
          <button class="chip order" type="button" data-order>In order seen</button>
        </nav>
        <main class="feed" data-static><div class="more">Loading…</div></main>
        <script src="client.js" type="module" />
      </body>
    </html>
  );
}
