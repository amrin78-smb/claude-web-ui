<script lang="ts">
  import { sessions, activeId, setActive, restartSession, resumeSession, syncSession } from '../stores/sessions';
  import { showPalette, showSettings, showDashboard, showDiff, openFolderPicker } from '../stores/ui';
  import { theme } from '../stores/theme';

  type Command = { label: string; run: () => void };

  let inputEl = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let selected = $state(0);

  $effect(() => {
    inputEl?.focus();
  });

  const commands = $derived.by<Command[]>(() => {
    const list: Command[] = [
      { label: 'New session', run: () => openFolderPicker('new') },
      { label: 'Change folder', run: () => openFolderPicker('current') },
    ];
    if ($activeId) {
      const active = $sessions.find((s) => s.id === $activeId);
      if (active?.resumable) {
        list.push({ label: 'Resume last conversation', run: () => resumeSession($activeId) });
      }
      list.push({ label: 'Restart Claude (fresh)', run: () => restartSession($activeId) });
      list.push({ label: 'Sync from GitHub', run: () => syncSession($activeId) });
    }
    list.push({ label: 'Show session overview', run: () => showDashboard.set(true) });
    list.push({ label: 'Toggle changes panel', run: () => showDiff.update((v) => !v) });
    list.push({ label: 'Open settings', run: () => showSettings.set(true) });
    // Opens Settings, where the actual confirm-then-progress flow lives (App section).
    list.push({ label: 'Update app', run: () => showSettings.set(true) });
    list.push({
      label: 'Toggle theme',
      run: () => theme.update((t) => (t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark')),
    });
    for (const s of $sessions) {
      list.push({ label: `Switch to: ${s.title}`, run: () => setActive(s.id) });
    }
    return list;
  });

  const filtered = $derived(
    commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
  );

  // Reset selection whenever the query changes.
  $effect(() => {
    query;
    selected = 0;
  });

  function close() {
    showPalette.set(false);
  }

  function runCommand(cmd: Command | undefined) {
    if (!cmd) return;
    cmd.run();
    close();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(filtered[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay palette-overlay" onclick={close}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="panel" onclick={(e) => e.stopPropagation()}>
    <input
      bind:this={inputEl}
      bind:value={query}
      {onkeydown}
      class="palette-input"
      type="text"
      placeholder="Type a command…"
      spellcheck="false"
      autocomplete="off"
    />
    <div class="list">
      {#each filtered as cmd, i (cmd.label)}
        <button
          type="button"
          class="row"
          class:selected={i === selected}
          onmousemove={() => (selected = i)}
          onclick={() => runCommand(cmd)}
        >
          {cmd.label}
        </button>
      {/each}
      {#if filtered.length === 0}
        <div class="empty">No commands</div>
      {/if}
    </div>
    <div class="hint">
      <kbd>↑</kbd><kbd>↓</kbd> navigate &nbsp; <kbd>↵</kbd> run &nbsp; <kbd>esc</kbd> close
    </div>
  </div>
</div>

<style>
  .palette-overlay {
    align-items: flex-start;
    justify-content: center;
  }
  .panel {
    margin-top: 12vh;
    width: min(560px, 92vw);
    max-height: 70vh;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .palette-input {
    margin: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 7px;
    padding: 10px 12px;
    font-size: 14px;
  }
  .palette-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .list {
    overflow-y: auto;
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: var(--text);
    padding: 9px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .row:hover {
    color: var(--text);
    border: none;
  }
  .row.selected {
    background: var(--panel-2);
  }
  .empty {
    padding: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .hint {
    border-top: 1px solid var(--border);
    padding: 8px 14px;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .hint kbd {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: inherit;
    font-size: 11px;
  }
</style>
