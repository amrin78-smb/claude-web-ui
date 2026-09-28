<script lang="ts">
  /* A generic browse-the-filesystem dialog, driven entirely by props.
   *
   * Distinct from FolderPicker.svelte on purpose: that one is the session
   * working-folder flow and is wired straight into the sessions stores
   * (createSession / setSessionCwd) plus the global showFolderPicker store.
   * This one just hands a path back to whoever opened it, which is what the
   * backup/restore fields need — three different destinations in one panel,
   * none of them touching sessions.
   *
   * `mode` decides what counts as a valid answer:
   *   folder — the directory you're looking at
   *   file   — one of the listed files (needs fileExt)
   *   either — a file if you click one, otherwise the current directory
   */
  import { toast } from '../stores/ui';
  import Icon from './Icon.svelte';

  type Entry = { name: string; path: string; bytes?: number };

  let {
    title = 'Choose a location',
    mode = 'folder' as 'folder' | 'file' | 'either',
    fileExt = '',
    start = '',
    hint = '',
    onpick,
    oncancel,
  }: {
    title?: string;
    mode?: 'folder' | 'file' | 'either';
    fileExt?: string;
    start?: string;
    hint?: string;
    onpick: (path: string) => void;
    oncancel: () => void;
  } = $props();

  let browsePath = $state('');
  let dirs = $state<Entry[]>([]);
  let files = $state<Entry[]>([]);
  let selectedFile = $state<string | null>(null);
  let manualInput = $state('');
  let loading = $state(false);

  const pathLabel = $derived(
    browsePath === '__drives__' ? 'This PC (pick a drive)' : browsePath || '…'
  );

  function humanBytes(n: number) {
    if (!n) return '';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return n >= 1024 * 1024 * 1024
      ? (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
      : (n / 1024 / 1024).toFixed(0) + ' MB';
  }

  async function loadDir(p: string) {
    loading = true;
    try {
      const q = new URLSearchParams({ path: p });
      if (fileExt) q.set('fileExt', fileExt);
      const r = await fetch('/api/dirs?' + q.toString());
      const data = await r.json();
      if (data.error) { toast(data.error); return; }
      browsePath = data.path;
      dirs = data.dirs || [];
      files = data.files || [];
      // A selection only means something in the folder it came from.
      selectedFile = null;
      parent = data.parent;
    } catch (err) {
      toast('could not read that folder');
    } finally {
      loading = false;
    }
  }

  let parent = $state<string | null>(null);

  function confirm() {
    // A typed path always wins — it's the escape hatch for somewhere you can't
    // browse to, like a folder that doesn't exist yet.
    const typed = manualInput.trim();
    if (typed) { onpick(typed); return; }

    if (mode === 'file') {
      if (!selectedFile) { toast(`pick a ${fileExt || 'file'}`); return; }
      onpick(selectedFile);
      return;
    }
    if (mode === 'either' && selectedFile) { onpick(selectedFile); return; }

    if (!browsePath || browsePath === '__drives__') { toast('pick a folder'); return; }
    onpick(browsePath);
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) oncancel();
  }

  function onManualKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') confirm();
  }

  loadDir(start);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" onclick={onOverlayClick}>
  <div class="modal">
    <h3>{title}</h3>

    <div class="pathbar">{pathLabel}</div>

    <div class="dirlist">
      {#if parent}
        <div class="row" onclick={() => loadDir(parent!)}>
          <Icon name="arrow-up" size={14} /> .. (up)
        </div>
      {/if}
      {#each dirs as d (d.path)}
        <div class="row" onclick={() => loadDir(d.path)}>
          <Icon name="folder" size={14} /> {d.name}
        </div>
      {/each}
      {#each files as f (f.path)}
        <div class="row file" class:selected={selectedFile === f.path}
             onclick={() => (selectedFile = f.path)}
             ondblclick={() => onpick(f.path)}>
          <Icon name="file" size={14} />
          <span class="fname">{f.name}</span>
          <span class="fsize">{humanBytes(f.bytes || 0)}</span>
        </div>
      {/each}
      {#if !loading && !dirs.length && !files.length}
        <div class="empty">nothing here{fileExt ? ` (looking for ${fileExt} files and folders)` : ''}</div>
      {/if}
    </div>

    <div class="modal-actions">
      <input
        class="manual"
        type="text"
        placeholder="…or type a full path (it doesn't have to exist yet)"
        bind:value={manualInput}
        onkeydown={onManualKeydown}
      />
      {#if hint}<span class="hint">{hint}</span>{/if}
      <button class="ghost" onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={confirm}>
        {selectedFile ? 'Use this file' : 'Use this folder'}
      </button>
    </div>
  </div>
</div>

<style>
  .pathbar {
    padding: 10px 18px;
    font-size: 13px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    word-break: break-all;
  }
  .dirlist {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
    min-height: 160px;
    max-height: 340px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 18px;
    font-size: 13px;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .row:hover { background: var(--panel-2); }
  .row.selected { background: var(--panel-2); outline: 1px solid var(--accent, var(--border)); }
  .fname { flex: 1; word-break: break-all; }
  .fsize { color: var(--muted); font-size: 12px; flex: 0 0 auto; }
  .empty { padding: 12px 18px; font-size: 13px; color: var(--muted); }
  .modal-actions {
    flex-wrap: wrap;
    align-items: center;
  }
  .manual { flex: 1 1 240px; }
  .hint {
    flex: 1 1 100%;
    font-size: 12px;
    color: var(--muted);
  }
</style>
