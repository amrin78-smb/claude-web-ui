<script lang="ts">
  import { sessions, activeId, createSession, setSessionCwd } from '../stores/sessions';
  import { showFolderPicker, folderPickerTarget, toast } from '../stores/ui';
  import Icon from './Icon.svelte';

  type Dir = { name: string; path: string };

  let browsePath = $state('');
  let dirs = $state<Dir[]>([]);
  let parent = $state<string | null>(null);
  let manualInput = $state('');

  const pathLabel = $derived(
    browsePath === '__drives__' ? 'This PC (pick a drive)' : browsePath
  );

  async function loadDir(p: string) {
    const r = await fetch('/api/dirs?path=' + encodeURIComponent(p));
    const data = await r.json();
    if (data.error) {
      toast(data.error);
      return;
    }
    browsePath = data.path;
    parent = data.parent;
    dirs = data.dirs;
  }

  function close() {
    showFolderPicker.set(false);
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function useFolder() {
    const target = manualInput.trim() || browsePath;
    if (!target || target === '__drives__') {
      toast('pick a folder');
      return;
    }
    if ($folderPickerTarget === 'new') {
      createSession(target);
    } else {
      if ($activeId) setSessionCwd($activeId, target);
      else createSession(target);
    }
    showFolderPicker.set(false);
  }

  function onManualKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') useFolder();
  }

  // Render only when open, so load the starting directory immediately.
  const start = $sessions.find((s) => s.id === $activeId)?.cwd ?? '';
  loadDir(start);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" onclick={onOverlayClick}>
  <div class="modal">
    <h3>Choose working folder</h3>

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
    </div>

    <div class="modal-actions">
      <input
        class="manual"
        type="text"
        placeholder="…or paste a full path and press Enter"
        bind:value={manualInput}
        onkeydown={onManualKeydown}
      />
      <span class="hint">Pick a folder for Claude Code to work in.</span>
      <button class="ghost" onclick={close}>Cancel</button>
      <button class="primary" onclick={useFolder}>Use this folder</button>
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
    min-height: 120px;
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
  .modal-actions {
    flex-wrap: wrap;
    align-items: center;
  }
  .manual { flex: 1 1 220px; }
  .hint {
    flex: 1 1 100%;
    font-size: 12px;
    color: var(--muted);
  }
</style>
