// Presentation is independent of where a post was captured.
export const INTERFACES = {
  original: { label: 'Original style', description: '' },
  hackernews: { label: 'Poster News', description: 'Headlines, small type, endless rabbit holes.' },
  ipod: { label: 'Postpod classic', description: '' },
  'ipod-color': { label: 'Postpod color', description: 'A pocket-sized archive with a click wheel.' },
  tinder: { label: 'Swipe', description: 'Skip left. Keep right. Nothing gets deleted.' },
  gallery: { label: 'Gallery', description: 'Pictures first. Follow your eye.' },
  terminal: { label: 'Terminal', description: 'Just the feed, straight to stdout.' },
  netflix: { label: 'Postflix', description: '' },
} as const;
export type Interface = keyof typeof INTERFACES;
export function interfaceOf(value: string | null): Interface {
  return value && Object.hasOwn(INTERFACES, value) ? value as Interface : 'original';
}
export const isPlayer = (view: Interface) => view === 'ipod' || view === 'ipod-color';
export const isDeck = (view: Interface) => isPlayer(view) || view === 'tinder';
