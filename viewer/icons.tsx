/** @jsxImportSource hono/jsx */
// Vector paths from the archived X and LinkedIn pages, October 2026.
import icons from './assets/icons.json';

export function Icon({ name, class: className = '' }: { name: string; class?: string }) {
  const icon = (icons as Record<string, { viewBox: string; paths: string[] }>)[name];
  if (!icon) return null;
  return <svg class={`icon ${className}`} viewBox={icon.viewBox} fill="currentColor" aria-hidden="true">{icon.paths.map(d => <path d={d} />)}</svg>;
}
