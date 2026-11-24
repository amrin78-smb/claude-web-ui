<!--
  CANONICAL Svelte 5 component example. Sub-agents: match this style exactly —
  $props() for props, $derived for computed values, onclick (not on:click),
  CSS variables from app.css. No `export let`, no `on:` directives.
-->
<script lang="ts">
  // `status` is a session's process state (or the connection's, in the top
  // bar). `activity`, when given, is what that process is doing, and refines a
  // running dot: working pulses, waiting-for-you is amber and pulses.
  let { status = 'stopped', activity = null, size = 10, title = '' }: {
    status?: string;
    activity?: string | null;
    size?: number;
    title?: string;
  } = $props();

  const state = $derived(
    status === 'running' && activity && activity !== 'idle' ? activity : status
  );
  const color = $derived(
    state === 'waiting' ? 'var(--warn)'
    : state === 'working' || state === 'starting' ? 'var(--accent)'
    : state === 'running' || state === 'idle' ? 'var(--ok)'
    : 'var(--danger)'
  );
</script>

<span
  class="dot"
  style="--c:{color}; width:{size}px; height:{size}px;"
  class:pulse={state === 'starting' || state === 'working' || state === 'waiting'}
  title={title || state}
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
  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; }
  }
</style>
