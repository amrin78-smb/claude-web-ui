import { writable } from 'svelte/store';

export type Theme = 'dark' | 'light' | 'system';

const storedTheme = (localStorage.getItem('theme') as Theme) || 'system';
const storedFont = Number(localStorage.getItem('fontSize')) || 14;

export const theme = writable<Theme>(storedTheme);
export const fontSize = writable<number>(storedFont);

function systemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && systemDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

theme.subscribe((t) => {
  localStorage.setItem('theme', t);
  apply(t);
});

fontSize.subscribe((n) => localStorage.setItem('fontSize', String(n)));

// React to OS theme changes while in 'system' mode.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let cur: Theme = 'system';
  theme.subscribe((t) => (cur = t))();
  if (cur === 'system') apply('system');
});
