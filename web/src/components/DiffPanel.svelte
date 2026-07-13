<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { conn } from '../lib/connection';
  import { activeId, requestDiff } from '../stores/sessions';
  import Icon from './Icon.svelte';

  type DiffFile = { path: string; status: string; added: number; removed: number };
  type DiffResult = {
    ok: boolean;
    isRepo: boolean;
    files: DiffFile[];
    patch: string;
    error?: string;
  };

  let loading = $state(false);
  let result = $state<DiffResult | null>(null);

  const patchLines = $derived(result?.patch ? result.patch.split('\n') : []);

  function lineClass(line: string): string {
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return 'ctx';
  }

  function refresh() {
    const id = $activeId;
    if (!id) return;
    loading = true;
    requestDiff(id);
  }

  $effect(() => {
    // Re-run whenever the active session changes; reset any stale result from
    // the previous session so we don't flash its diff while the new one loads.
    const id = $activeId;
    result = null;
    if (id) {
      loading = true;
      requestDiff(id);
    } else {
      loading = false;
    }
  });

  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = conn.on((m) => {
      // Responses are broadcast to every socket, not just the requester, so a
      // diff for a session the user has since navigated away from can still
      // arrive — filter by id and drop it if it's stale.
      if (m.type === 'gitdiff' && m.id === $activeId) {
        loading = false;
        result = { ok: m.ok, isRepo: m.isRepo, files: m.files || [], patch: m.patch || '', error: m.error };
      } else if (m.type === 'idle' && m.id === $activeId) {
        // Claude just finished a turn on the active session — pull the latest diff.
        refresh();
      }
    });
  });

  onDestroy(() => {
    unsub?.();
  });
</script>

<div class="diff-panel">
  <div class="header">
    <span class="title">Changes</span>
    <button class="ghost" onclick={refresh} disabled={!$activeId || loading} title="Refresh diff">
      <span class={loading ? 'spin' : ''}><Icon name="refresh" size={14} /></span> Refresh
    </button>
  </div>

  <div class="body">
    {#if !$activeId}
      <div class="empty">Open a session to see its changes.</div>
    {:else if loading && !result}
      <div class="empty loading-row">
        <span class="spin"><Icon name="refresh" size={16} /></span>
        Loading diff…
      </div>
    {:else if result && !result.ok && result.error}
      <div class="empty error fade-in">{result.error}</div>
    {:else if result && !result.isRepo}
      <div class="empty empty-block fade-in">
        <Icon name="git-branch" size={28} />
        <span>Not a git repository.</span>
      </div>
    {:else if result && result.files.length === 0}
      <div class="empty fade-in">No changes.</div>
    {:else if result}
      <div class="files fade-in">
        {#each result.files as f (f.path)}
          <div class="file-row">
            <span class="status-badge">{f.status}</span>
            <span class="path" title={f.path}>{f.path}</span>
            <span class="counts">
              {#if f.added}<span class="add">+{f.added}</span>{/if}
              {#if f.removed}<span class="del">-{f.removed}</span>{/if}
            </span>
          </div>
        {/each}
      </div>
      {#if result.patch}
        <pre class="patch fade-in">{#each patchLines as line}<div class={'pline ' + lineClass(line)}>{line}</div>{/each}</pre>
      {/if}
    {/if}
  </div>
</div>

<style>
  .diff-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--panel);
  }

  .header {
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
  .title {
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }
  .header button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 9px;
    font-size: 12px;
  }
  .header button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .empty {
    padding: 18px 14px;
    color: var(--muted);
    font-size: 13px;
  }
  .empty.error {
    color: var(--danger);
  }
  .loading-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .empty-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 14px;
    opacity: 0.7;
  }

  .files {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .file-row:last-child { border-bottom: none; }

  .status-badge {
    flex: none;
    min-width: 18px;
    text-align: center;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .counts {
    flex: none;
    display: flex;
    gap: 6px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 11px;
  }
  .counts .add { color: var(--ok); }
  .counts .del { color: var(--danger); }

  .patch {
    margin: 0;
    padding: 8px 0 12px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
    overflow-x: auto;
  }
  .pline {
    padding: 0 12px;
  }
  .pline.add { color: var(--ok); }
  .pline.del { color: var(--danger); }
  .pline.hunk { color: var(--accent); }
  .pline.meta { color: var(--muted); }
  .pline.ctx { color: var(--text); }
</style>
