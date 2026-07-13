<script lang="ts">
  import StatusDot from './StatusDot.svelte';
  import Icon from './Icon.svelte';
  import { sessions, activeId, setActive, closeSession, restartSession } from '../stores/sessions';
  import { showDashboard } from '../stores/ui';
  import type { Session } from '../stores/sessions';

  function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }

  function usageLabel(u: NonNullable<Session['usage']>): string {
    const total = u.input + u.output + u.cacheRead + u.cacheCreation;
    return `$${u.costUSD.toFixed(2)} · ${formatTokens(total)} tok`;
  }

  function open(id: string) {
    setActive(id);
    showDashboard.set(false);
  }
</script>

<div class="dashboard">
  <div class="header">
    <h2>Sessions</h2>
    <button class="ghost icon" title="Close" onclick={() => showDashboard.set(false)}><Icon name="x" size={14} /></button>
  </div>

  {#if $sessions.length === 0}
    <div class="empty fade-in">
      <Icon name="grid" size={40} />
      <div class="empty-title">No sessions open</div>
      <div class="empty-hint">Open a folder to get started</div>
    </div>
  {:else}
    <div class="grid fade-in">
      {#each $sessions as s (s.id)}
        <div
          class="card"
          class:active={s.id === $activeId}
          title={s.cwd}
          onclick={() => open(s.id)}
        >
          <div class="row top">
            <div class="status">
              <StatusDot status={s.status} size={9} />
              {#if s.busy}
                <span class="busy" title="Working"></span>
              {/if}
            </div>
            {#if s.usage}
              <span class="badge">{usageLabel(s.usage)}</span>
            {/if}
          </div>

          <div class="title">{s.title}</div>
          <div class="cwd">{basename(s.cwd)}</div>

          {#if s.preview}
            <div class="preview">{s.preview}</div>
          {/if}

          <div class="actions">
            <button class="primary" onclick={(e) => { e.stopPropagation(); open(s.id); }}>Open</button>
            <button class="ghost" onclick={(e) => { e.stopPropagation(); restartSession(s.id); }}>Restart</button>
            <button class="ghost" onclick={(e) => { e.stopPropagation(); closeSession(s.id); }}>Close</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Opaque full-bleed overlay: sits on top of the always-mounted terminal
     components, so it needs a solid background (not the .overlay scrim
     pattern, which is translucent and meant for centered modals). */
  .dashboard {
    position: absolute;
    inset: 0;
    z-index: 10;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    overflow: auto;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .header h2 {
    margin: 0;
    font-size: 16px;
    color: var(--text);
  }
  .icon {
    line-height: 1;
    padding: 6px 10px;
  }

  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--muted);
  }
  .empty :global(svg) {
    opacity: 0.4;
  }
  .empty-title {
    margin-top: 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .empty-hint {
    font-size: 13px;
    color: var(--muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
    padding: 20px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .card:hover {
    border-color: var(--accent);
    background: var(--panel-2);
  }
  .card.active {
    border-color: var(--accent);
  }

  .row.top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .busy {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 0.9s ease-in-out infinite;
  }
  @keyframes pulse {
    50% { opacity: 0.25; }
  }

  .badge {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--muted);
    flex: none;
  }

  .title {
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cwd {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: -4px;
  }

  .preview {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 6px;
  }
  .actions button {
    flex: 1 1 auto;
    font-size: 12px;
    padding: 6px 8px;
  }
</style>
