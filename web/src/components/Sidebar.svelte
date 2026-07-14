<script lang="ts">
  import StatusDot from './StatusDot.svelte';
  import Icon from './Icon.svelte';
  import PlanUsage from './PlanUsage.svelte';
  import { sessions, activeId, createSession, closeSession, setActive } from '../stores/sessions';
  import { config, togglePinned } from '../stores/config';
  import { openFolderPicker } from '../stores/ui';

  function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  const recents = $derived($config.recents.filter((p) => !$config.pinned.includes(p)));
</script>

<aside class="sidebar">
  <div class="brand">
    <span class="brand-dot"></span>
    <span class="wordmark">Claude Code</span>
  </div>

  <button class="primary new-btn" onclick={() => openFolderPicker('new')}>
    <Icon name="plus" size={14} /> New session
  </button>

  {#if $config.pinned.length}
    <section class="section">
      <div class="head">Pinned</div>
      <div class="list">
        {#each $config.pinned as path (path)}
          <div class="row" title={path} onclick={() => createSession(path)}>
            <span class="label">{basename(path)}</span>
            <button
              class="ghost icon star"
              title="Unpin"
              onclick={(e) => { e.stopPropagation(); togglePinned(path); }}
            ><Icon name="star-filled" size={13} /></button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if recents.length}
    <section class="section">
      <div class="head">Recent</div>
      <div class="list">
        {#each recents as path (path)}
          <div class="row" title={path} onclick={() => createSession(path)}>
            <span class="label">{basename(path)}</span>
            <button
              class="ghost icon star"
              title="Pin"
              onclick={(e) => { e.stopPropagation(); togglePinned(path); }}
            ><Icon name="star" size={13} /></button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class="section sessions">
    <div class="head">Sessions</div>
    <div class="list">
      {#each $sessions as s (s.id)}
        <div
          class="row"
          class:active={s.id === $activeId}
          title={s.cwd}
          onclick={() => setActive(s.id)}
        >
          <StatusDot status={s.status} size={8} />
          <span class="label">{s.title}</span>
          <button
            class="ghost icon close"
            title="Close session"
            onclick={(e) => { e.stopPropagation(); closeSession(s.id); }}
          ><Icon name="x" size={13} /></button>
        </div>
      {/each}
    </div>
  </section>

  <PlanUsage />
</aside>

<style>
  .sidebar {
    width: 230px;
    flex: none;
    height: 100%;
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 12px 10px;
    gap: 14px;
    overflow: hidden;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
  }
  .brand-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 7px color-mix(in srgb, var(--accent) 60%, transparent);
    flex: none;
  }
  .wordmark {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .new-btn {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  .section.sessions {
    flex: 1 1 auto;
    min-height: 0;
  }

  .head {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 6px;
    margin-bottom: 2px;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    min-height: 0;
  }
  .section.sessions .list {
    max-height: none;
  }
  .section:not(.sessions) .list {
    max-height: 180px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border-radius: 7px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    border-left: 2px solid transparent;
    user-select: none;
    transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }
  .row:hover {
    background: var(--panel-2);
  }
  .row.active {
    background: var(--panel-2);
    border-left-color: var(--accent);
  }

  .label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    border-radius: 5px;
  }

  .star {
    color: var(--muted);
  }
  .star:hover {
    color: var(--accent);
  }

  .close {
    opacity: 0;
    color: var(--muted);
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .row:hover .close {
    opacity: 1;
  }
  .close:hover {
    color: var(--danger);
  }
</style>
