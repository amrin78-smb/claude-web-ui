<script lang="ts">
  import Icon from './Icon.svelte';
  import { activeId } from '../stores/sessions';
  import { activeImages, imageUrl, toolLabel, viewing, showImages } from '../stores/images';

  // Newest first: the screenshot Claude just took is the one you came for.
  const list = $derived([...$activeImages].reverse());

  function time(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
</script>

<div class="image-panel">
  <div class="header">
    <span class="title">Images{#if list.length}&nbsp;<span class="count">{list.length}</span>{/if}</span>
    <button class="ghost" onclick={() => showImages.set(false)} title="Close"><Icon name="x" size={14} /></button>
  </div>

  <div class="body">
    {#if !$activeId}
      <div class="empty">Open a session to see its images.</div>
    {:else if list.length === 0}
      <div class="empty empty-block">
        <Icon name="image" size={28} />
        <span>No images yet.</span>
        <small>Screenshots Claude takes while testing (and images it opens) show up here, because the terminal can't draw them.</small>
      </div>
    {:else}
      <div class="grid fade-in">
        {#each list as img (img.id)}
          <button class="card" onclick={() => viewing.set({ sessionId: $activeId, imageId: img.id })} title="View full size">
            <img src={imageUrl($activeId, img.id)} alt={toolLabel(img.tool)} loading="lazy" />
            <span class="meta">
              <span class="tool">{toolLabel(img.tool)}</span>
              <span class="time">{time(img.ts)}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .image-panel {
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
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title { color: var(--text); font-size: 13px; font-weight: 600; }
  .count { color: var(--muted); font-weight: 400; }
  .header button { padding: 5px 7px; display: inline-flex; }

  .body { flex: 1; min-height: 0; overflow-y: auto; }
  .empty { padding: 18px 14px; color: var(--muted); font-size: 13px; }
  .empty-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    padding-top: 40px;
  }
  .empty-block small { max-width: 260px; line-height: 1.45; }

  .grid { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
    cursor: zoom-in;
    text-align: left;
    color: var(--text);
  }
  .card:hover { border-color: var(--accent); }
  .card img {
    width: 100%;
    max-height: 260px;
    object-fit: contain;
    border-radius: 5px;
    background: var(--bg);
  }
  .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); padding: 0 2px; }
  .tool { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { flex: none; font-variant-numeric: tabular-nums; }
</style>
