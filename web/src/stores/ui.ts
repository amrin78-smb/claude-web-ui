import { writable } from 'svelte/store';

export const showFolderPicker = writable(false);
export const folderPickerTarget = writable<'new' | 'current'>('new');
export const showSettings = writable(false);
export const showPalette = writable(false);
export const showDashboard = writable(false);
export const showDiff = writable(false);

export type Toast = { id: number; text: string };
export const toasts = writable<Toast[]>([]);

let nextId = 0;
export function toast(text: string) {
  const id = ++nextId;
  toasts.update((a) => [...a, { id, text }]);
  setTimeout(() => toasts.update((a) => a.filter((t) => t.id !== id)), 2600);
}

/** Open the folder picker in 'new' (create session) or 'current' (change folder) mode. */
export function openFolderPicker(target: 'new' | 'current' = 'new') {
  folderPickerTarget.set(target);
  showFolderPicker.set(true);
}
