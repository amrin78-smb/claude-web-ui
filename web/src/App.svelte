<script lang="ts">
  import { conn } from './lib/connection';
  import { sessions, activeId } from './stores/sessions';
  import {
    showPalette, showFolderPicker, showSettings, showDashboard, showDiff,
    openFolderPicker, toast,
  } from './stores/ui';
  import { pendingCount, clearPending } from './lib/notify';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Tabs from './components/Tabs.svelte';
  import Terminal from './components/Terminal.svelte';
  import Dashboard from './components/Dashboard.svelte';
  import DiffPanel from './components/DiffPanel.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import FolderPicker from './components/FolderPicker.svelte';
  import Settings from './components/Settings.svelte';
  import Toasts from './components/Toasts.svelte';
  import Icon from './components/Icon.svelte';

  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);

  // ---- global keyboard shortcuts ----
  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      showDashboard.update((v) => !v);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      showPalette.update((v) => !v);
    } else if (e.key === 'Escape') {
      showPalette.set(false);
      showFolderPicker.set(false);
      showSettings.set(false);
      showDashboard.set(false);
    }
  }

  // Tab-title badge for sessions that finished while the user wasn't watching.
  $effect(() => {
    const n = $pendingCount;
    document.title = n > 0 ? `(${n}) Claude Code` : 'Claude Code';
  });

  // Switching sessions counts as "seeing" whatever just finished.
  $effect(() => {
    $activeId;
    clearPending();
  });

  // ---- paste image / attach file / drag-drop, targeting the active session ----
  function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
  }

  async function sendImage(blob: Blob) {
    const id = $activeId;
    if (!id) { toast('Open a folder first'); return; }
    const ext = (blob.type.split('/')[1] || 'png');
    const data = await readAsBase64(blob as File);
    conn.send({ type: 'image', id, data, ext });
    toast('image attached');
  }

  async function sendFile(file: File) {
    const id = $activeId;
    if (!id) { toast('Open a folder first'); return; }
    const data = await readAsBase64(file);
    conn.send({ type: 'file', id, name: file.name, data });
    toast('attaching ' + file.name + '…');
  }

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items ?? [];
    for (const it of items) {
      if (it.type?.startsWith('image/')) {
        e.preventDefault();
        e.stopPropagation();
        const blob = it.getAsFile();
        if (blob) sendImage(blob);
        return;
      }
    }
  }

  function onDragEnter(e: DragEvent) {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault(); dragDepth++;
    }
  }
  function onDragOver(e: DragEvent) {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
  }
  function onDragLeave() { dragDepth = Math.max(0, dragDepth - 1); }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault(); dragDepth = 0;
    for (const f of e.dataTransfer.files) sendFile(f);
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  onpaste={onPaste}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
/>

<div class="layout">
  <Sidebar />
  <main>
    <TopBar />
    <Tabs />
    <div class="body">
      <div class="stage">
        {#if $sessions.length === 0}
          <div class="empty">
            <div class="empty-card">
              <h2>Claude Code</h2>
              <p>Open a folder to start a session.</p>
              <button class="primary" onclick={() => openFolderPicker('new')}><Icon name="folder" size={14} /> Open folder</button>
              <div class="kbd-hint">Press <kbd>Ctrl</kbd>+<kbd>K</kbd> for the command palette</div>
            </div>
          </div>
        {:else}
          {#each $sessions as session (session.id)}
            <Terminal {session} active={session.id === $activeId} />
          {/each}
        {/if}
        {#if $showDashboard}<Dashboard />{/if}
      </div>
      {#if $showDiff}
        <div class="diff-wrap"><DiffPanel /></div>
      {/if}
    </div>
  </main>
</div>

{#if dragging}
  <div class="dropzone">
    <div class="dz-inner"><Icon name="paperclip" size={22} /> Drop files to attach<br /><small>PDF · Excel · Word · CSV · images · anything</small></div>
  </div>
{/if}

{#if $showPalette}<CommandPalette />{/if}
{#if $showFolderPicker}<FolderPicker />{/if}
{#if $showSettings}<Settings />{/if}
<Toasts />

<style>
  .layout { display: grid; grid-template-columns: auto 1fr; height: 100vh; }
  main { display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
  .body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .stage { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .diff-wrap {
    flex: none;
    width: 38%;
    min-width: 320px;
    max-width: 640px;
    border-left: 1px solid var(--border);
  }

  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .empty-card { text-align: center; color: var(--muted); }
  .empty-card h2 { color: var(--text); margin: 0 0 6px; }
  .empty-card p { margin: 0 0 16px; }
  .empty-card .primary { font-size: 14px; padding: 9px 18px; }
  .kbd-hint { margin-top: 18px; font-size: 12px; }
  kbd {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    padding: 1px 6px; font-family: inherit; font-size: 11px;
  }

  .dropzone {
    position: fixed; inset: 0; z-index: 70;
    display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(2px);
  }
  .dz-inner {
    border: 2px dashed var(--accent); border-radius: 16px;
    padding: 48px 64px; text-align: center; font-size: 22px; font-weight: 600;
    color: var(--text); background: var(--panel);
  }
  .dz-inner small { font-size: 13px; font-weight: 400; color: var(--muted); }
</style>
