<!--
  CANONICAL Svelte 5 component example. Sub-agents: match this style exactly —
  $props() for props, $derived for computed values, onclick (not on:click),
  CSS variables from app.css. No `export let`, no `on:` directives.
-->
<script lang="ts">
  let { status = 'stopped', size = 10 }: { status?: string; size?: number } = $props();

  const color = $derived(
    status === 'running' ? 'var(--ok)' : status === 'starting' ? 'var(--accent)' : 'var(--danger)'
  );
</script>

<span
  class="dot"
  style="--c:{color}; width:{size}px; height:{size}px;"
  class:pulse={status === 'starting'}
  title={status}
></span>

<style>
  .dot {
    display: inline-block;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 7px color-mix(in srgb, var(--c) 60%, transparent);
    flex: none;
  }
  .pulse { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
</style>
