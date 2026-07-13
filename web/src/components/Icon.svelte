<script lang="ts">
  import { ICONS } from '../lib/icons';

  let { name, size = 16 }: { name: keyof typeof ICONS; size?: number } = $props();

  const filled = $derived(name.endsWith('-filled'));
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="icon"
  aria-hidden="true"
>
  {@html ICONS[name] ?? ''}
</svg>

<style>
  .icon {
    display: inline-block;
    vertical-align: middle;
    flex: none;
  }
</style>
