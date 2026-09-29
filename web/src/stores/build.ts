import { writable } from 'svelte/store';
import { conn } from '../lib/connection';

/** What the connected server is: its version, and how it was installed. */
export type Build = {
  version: string;
  /** 'packaged' = installed from a .exe/.deb; 'dev' = running from a git checkout. */
  mode: 'packaged' | 'dev' | '';
};

export const build = writable<Build>({ version: '', mode: '' });

// Pushed once per connection rather than requested — it can't change while the
// server process lives. A reconnect after an update restart carries the new
// version with it, so the UI corrects itself without a reload.
conn.on((m) => {
  if (m.type === 'build') {
    build.set({ version: m.version || '', mode: m.mode || '' });
  }
});
