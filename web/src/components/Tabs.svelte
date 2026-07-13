<script lang="ts">
  import StatusDot from './StatusDot.svelte';
  import Icon from './Icon.svelte';
  import { sessions, activeId, closeSession, setActive } from '../stores/sessions';
  import { openFolderPicker, showDashboard } from '../stores/ui';
</script>

{#if $sessions.length}
  <div class="tabs">
    {#each $sessions as s (s.id)}
      <div
        class="tab"
        class:active={s.id === $activeId}
        title={s.cwd}
        onclick={() => setActive(s.id)}
      >
        <StatusDot status={s.status} size={7} />
        <span class="label">{s.title}</span>
        <button
          class="ghost close"
          title="Close session"
          onclick={(e) => { e.stopPropagation(); closeSession(s.id); }}
        ><Icon name="x" size={12} /></button>
      </div>
    {/each}
    <button class="ghost add" title="Session overview" onclick={() => showDashboard.set(true)}><Icon name="grid" size={13} /></button>
    <button class="ghost add" title="New session" onclick={() => openFolderPicker('new')}><Icon name="plus" size={14} /></button>
  </div>
{:else}
  <div class="tabs empty"></div>
{/if}

<style>
  .tabs {
    display: flex;
    align-items: stretch;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
  }
  .tabs.empty {
    height: 0;
    border-bottom: none;
    overflow: hidden;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
    border-right: 1px solid var(--border);
    border-top: 2px solid transparent;
    flex: none;
    max-width: 200px;
    user-select: none;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .tab:hover {
    color: var(--text);
    background: var(--panel-2);
  }
  .tab.active {
    background: var(--bg);
    color: var(--text);
    border-top-color: var(--accent);
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    border-radius: 5px;
    color: var(--muted);
    transition: color var(--dur-fast) var(--ease);
  }
  .close:hover {
    color: var(--danger);
  }

  .add {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 14px;
    border: none;
    border-radius: 0;
    color: var(--muted);
    transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }
  .add:hover {
    color: var(--accent);
    background: var(--panel-2);
  }
</style>
