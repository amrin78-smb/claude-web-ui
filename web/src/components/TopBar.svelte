<script lang="ts">
  import { onMount } from 'svelte';
  import { conn } from '../lib/connection';
  import { sessions, activeId, restartSession, syncSession } from '../stores/sessions';
  import { showSettings, showDashboard, showDiff, openFolderPicker, toast } from '../stores/ui';
  import { theme } from '../stores/theme';
  import StatusDot from './StatusDot.svelte';
  import Icon from './Icon.svelte';

  let connStatus = $state('connecting');

  let imageInput: HTMLInputElement;
  let fileInput: HTMLInputElement;

  const activeSession = $derived($sessions.find((s) => s.id === $activeId));
  const cwd = $derived(activeSession?.cwd || 'No session');

  const dotStatus = $derived(connStatus === 'connected' ? 'running' : 'starting');
  const connLabel = $derived(connStatus === 'connected' ? 'connected' : 'reconnecting…');

  onMount(() => {
    return conn.onStatus((s) => (connStatus = s));
  });

  function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
  }

  function pickFolder() {
    if (!$activeId) { toast('Open a folder first'); return; }
    openFolderPicker('current');
  }

  function pasteImage() {
    if (!$activeId) { toast('Open a folder first'); return; }
    imageInput.click();
  }

  async function onImagePick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      const data = await readAsBase64(file);
      const ext = file.type.split('/')[1] || 'png';
      conn.send({ type: 'image', id: $activeId, data, ext });
      toast('image attached');
    }
    input.value = '';
  }

  function attachFile() {
    if (!$activeId) { toast('Open a folder first'); return; }
    fileInput.click();
  }

  async function onFilePick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      const data = await readAsBase64(file);
      conn.send({ type: 'file', id: $activeId, name: file.name, data });
      toast('attaching ' + file.name + '…');
    }
    input.value = '';
  }

  function restart() {
    if (!$activeId) { toast('Open a folder first'); return; }
    restartSession($activeId);
  }

  function sync() {
    if (!$activeId) { toast('Open a folder first'); return; }
    syncSession($activeId);
  }

  function cycleTheme() {
    theme.update((t) => (t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark'));
  }
</script>

<header class="topbar">
  <div class="left">
    <span class="path" title={cwd}>{cwd}</span>
    <span class="conn">
      <StatusDot status={dotStatus} size={8} />
      <span class="conn-label">{connLabel}</span>
    </span>
  </div>

  <div class="right">
    <button class="ghost labeled" onclick={() => showDashboard.update((v) => !v)} title="Session overview (Ctrl+Shift+O)"><Icon name="grid" size={14} /> Overview</button>
    <button class="ghost labeled" onclick={() => showDiff.update((v) => !v)} title="Toggle changes panel"><Icon name="git-branch" size={14} /> Diff</button>
    <button class="ghost labeled" onclick={pickFolder} disabled={!$activeId} title="Open folder"><Icon name="folder" size={14} /> Folder</button>
    <button class="ghost iconbtn" onclick={pasteImage} disabled={!$activeId} title="Paste image"><Icon name="image" size={14} /></button>
    <button class="ghost iconbtn" onclick={attachFile} disabled={!$activeId} title="Attach file"><Icon name="paperclip" size={14} /></button>
    <button class="ghost labeled" onclick={restart} disabled={!$activeId} title="Restart session"><Icon name="refresh" size={14} /> Restart</button>
    <button class="ghost labeled" onclick={sync} disabled={!$activeId} title="Sync session"><Icon name="refresh" size={14} /> Sync</button>
    <button class="ghost iconbtn" onclick={cycleTheme} title="Toggle theme"><Icon name="sun" size={14} /></button>
    <button class="ghost iconbtn" onclick={() => showSettings.set(true)} title="Settings"><Icon name="settings" size={14} /></button>
    <span class="hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>
  </div>

  <input
    bind:this={imageInput}
    type="file"
    accept="image/*"
    class="hidden"
    onchange={onImagePick}
  />
  <input
    bind:this={fileInput}
    type="file"
    multiple
    class="hidden"
    onchange={onFilePick}
  />
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 48px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex: none;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .path {
    color: var(--text);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .conn {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .conn-label {
    color: var(--muted);
    font-size: 12px;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .right button {
    padding: 5px 9px;
    font-size: 12px;
  }
  .right button:disabled {
    opacity: 0.4;
    cursor: default;
    color: var(--text);
    border-color: transparent;
    background: transparent;
  }
  .right .labeled {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .right .iconbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .hint {
    margin-left: 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .hint kbd {
    padding: 3px 7px;
    font-size: 11px;
    font-family: inherit;
    color: var(--muted);
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 5px;
  }

  .hidden { display: none; }
</style>
