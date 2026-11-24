import { writable, derived, get } from 'svelte/store';
import { sessions, activeId } from './sessions';
import { showDiff } from './ui';

// Pictures a session's tools handed Claude (screenshots of the app or game it
// is testing, images it Read). The browser terminal can't draw them, so the
// bridge mod forwards them and they're shown in their own panel.
export type SessionImage = { id: string; ts: number; tool: string; mediaType: string; size: number };

export const showImages = writable(false);
// The picture open full size, or null.
export const viewing = writable<{ sessionId: string; imageId: string } | null>(null);
// The latest picture of the active session, popped up while the panel is closed.
export const peek = writable<{ sessionId: string; image: SessionImage } | null>(null);

export const activeImages = derived([sessions, activeId], ([$sessions, $activeId]) =>
  ($sessions.find((s) => s.id === $activeId)?.images ?? []) as SessionImage[]
);

export function imageUrl(sessionId: string, imageId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`;
}

// "mcp__playwright__browser_take_screenshot" -> "playwright: browser take screenshot".
export function toolLabel(tool: string): string {
  if (!tool) return 'image';
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    return `${server}: ${rest.join(' ').replace(/_/g, ' ')}`;
  }
  return tool;
}

// The two side panels share one slot beside the terminal.
export function toggleImages() {
  const next = !get(showImages);
  showImages.set(next);
  if (next) {
    showDiff.set(false);
    peek.set(null);
  }
}
showDiff.subscribe((v) => { if (v) showImages.set(false); });

// Pop up a picture when one arrives for the session being looked at. Only new
// arrivals: the first sighting of a session (page load, switching tabs) just
// records what's there, or every reload would replay the last screenshot.
const seen = new Map<string, string>();
let peekTimer: ReturnType<typeof setTimeout> | undefined;
sessions.subscribe((list) => {
  const active = get(activeId);
  for (const s of list) {
    const imgs = (s.images ?? []) as SessionImage[];
    const last = imgs[imgs.length - 1]?.id ?? '';
    const before = seen.get(s.id);
    seen.set(s.id, last);
    if (before === undefined || !last || last === before) continue;
    if (s.id !== active || get(showImages)) continue;
    peek.set({ sessionId: s.id, image: imgs[imgs.length - 1] });
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => peek.set(null), 15000);
  }
});
activeId.subscribe(() => peek.set(null));
