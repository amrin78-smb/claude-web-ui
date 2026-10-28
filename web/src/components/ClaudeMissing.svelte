<!--
  Banner shown when the Claude CLI isn't installed (or isn't anywhere the server
  can see). Without it, a fresh install just fails every session with a terminal
  error, after you've already opened one. Re-checks when the window regains
  focus, so it goes away by itself once you've installed Claude in a terminal
  and switched back.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../stores/ui';

  let missing = $state(false);
  let install = $state('');
  let checking = $state(false);

  async function check() {
    checking = true;
    try {
      const res = await fetch('/api/claude');
      if (res.ok) {
        const s = await res.json();
        missing = !s.found;
        install = s.install || '';
      }
    } catch {
      // Server unreachable: the connection indicator already says so.
    } finally {
      checking = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(install);
      toast('copied');
    } catch {
      toast('copy failed — select the command and copy it by hand');
    }
  }

  onMount(() => { check(); });
</script>

<svelte:window onfocus={() => { if (missing) check(); }} />

{#if missing}
  <div class="claude-missing" role="alert">
    <div class="text">
      <strong>Claude Code isn't installed.</strong>
      Sessions can't start until it is. Run this in a terminal, then run
      <code>claude</code> once to sign in:
    </div>
    <div class="cmd">
      <code>{install}</code>
      <button onclick={copy}>Copy</button>
      <button onclick={check} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
    </div>
  </div>
{/if}

<style>
  .claude-missing {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--danger) 12%, var(--panel));
    border-bottom: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    color: var(--text);
    font-size: 13px;
  }
  .text { flex: 1 1 320px; line-height: 1.5; }
  .cmd { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  code {
    font-family: Consolas, "Cascadia Code", "Courier New", monospace;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .cmd code { user-select: all; }
  button { font-size: 12px; padding: 4px 10px; }
</style>
