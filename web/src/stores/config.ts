import { writable, get } from 'svelte/store';
import { conn } from '../lib/connection';

export type SyncRepo = { name: string; url: string; branch?: string };

/** Cloudflare Access setup for reaching this server through a tunnel. */
export type RemoteAccess = { hostname: string; teamDomain: string; aud: string };

export type Config = {
  repoUrl: string;
  branch: string;
  autoSync: boolean;
  /** Open a stopped session and it starts itself, resuming its conversation. */
  autoResume: boolean;
  recents: string[];
  pinned: string[];
  syncWorkDir: string;
  syncRepos: SyncRepo[];
  remote: RemoteAccess;
};

const DEFAULT: Config = {
  repoUrl: '',
  branch: '',
  autoSync: false,
  autoResume: true,
  recents: [],
  pinned: [],
  syncWorkDir: '',
  syncRepos: [],
  remote: { hostname: '', teamDomain: '', aud: '' },
};

export const config = writable<Config>({ ...DEFAULT });

conn.on((m) => {
  if (m.type === 'config') {
    config.update((c) => ({
      ...c,
      repoUrl: m.repoUrl ?? c.repoUrl,
      branch: m.branch ?? c.branch,
      autoSync: !!m.autoSync,
      recents: m.recents ?? c.recents,
      pinned: m.pinned ?? c.pinned,
      syncWorkDir: m.syncWorkDir ?? c.syncWorkDir,
      syncRepos: m.syncRepos ?? c.syncRepos,
      remote: m.remote ?? c.remote,
    }));
  }
});

conn.onStatus((s) => {
  if (s === 'connected') conn.send({ type: 'getconfig' });
});

function push() {
  const c = get(config);
  conn.send({ type: 'saveconfig', ...c });
}

export function saveConfig(patch: Partial<Config>) {
  config.update((c) => ({ ...c, ...patch }));
  push();
}

export function addRecent(path: string) {
  config.update((c) => {
    const recents = [path, ...c.recents.filter((p) => p !== path)].slice(0, 12);
    return { ...c, recents };
  });
  push();
}

export function togglePinned(path: string) {
  config.update((c) => {
    const pinned = c.pinned.includes(path)
      ? c.pinned.filter((p) => p !== path)
      : [...c.pinned, path];
    return { ...c, pinned };
  });
  push();
}
