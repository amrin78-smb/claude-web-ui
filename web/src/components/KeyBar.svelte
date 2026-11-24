<script lang="ts">
  // The keys a phone keyboard doesn't have but Claude Code needs: Esc to
  // interrupt, Tab/Shift+Tab for completion and mode cycling, arrows for menus
  // and history, Ctrl+C. Shown only on touch screens (see the media query).
  // Buttons act on pointerdown and cancel the default so the terminal keeps
  // focus — otherwise every tap would close the on-screen keyboard.
  import { conn } from '../lib/connection';
  import { activeId } from '../stores/sessions';

  const KEYS: { label: string; title: string; data: string }[] = [
    { label: 'Esc', title: 'Escape: interrupt Claude or close a menu', data: '\x1b' },
    { label: 'Tab', title: 'Tab', data: '\t' },
    { label: '⇧Tab', title: 'Shift+Tab: cycle permission mode', data: '\x1b[Z' },
    { label: '↑', title: 'Up', data: '\x1b[A' },
    { label: '↓', title: 'Down', data: '\x1b[B' },
    { label: '←', title: 'Left', data: '\x1b[D' },
    { label: '→', title: 'Right', data: '\x1b[C' },
    { label: '^C', title: 'Ctrl+C', data: '\x03' },
    { label: '⏎', title: 'Enter', data: '\r' },
  ];

  function press(e: PointerEvent, data: string) {
    e.preventDefault();
    const id = $activeId;
    if (id) conn.send({ type: 'input', id, data });
  }
</script>

{#if $activeId}
  <div class="keybar" role="toolbar" aria-label="Terminal keys">
    {#each KEYS as k (k.label)}
      <button type="button" title={k.title} aria-label={k.title} onpointerdown={(e) => press(e, k.data)}>{k.label}</button>
    {/each}
  </div>
{/if}

<style>
  .keybar {
    display: none;
    flex: none;
    gap: 6px;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    overflow-x: auto;
    background: var(--panel);
    border-top: 1px solid var(--border);
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .keybar::-webkit-scrollbar { display: none; }
  @media (pointer: coarse) {
    .keybar { display: flex; }
  }
  button {
    flex: none;
    min-width: 44px;
    height: 36px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
