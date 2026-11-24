<script lang="ts">
  // Full-size view of one session picture, plus the pop-up that announces a new
  // one while the Images panel is closed. Both live above the terminal stage.
  import Icon from './Icon.svelte';
  import { sessions } from '../stores/sessions';
  import { viewing, peek, imageUrl, toolLabel, showImages, type SessionImage } from '../stores/images';

  const list = $derived(
    $viewing ? (($sessions.find((s) => s.id === $viewing.sessionId)?.images ?? []) as SessionImage[]) : []
  );
  const index = $derived($viewing ? list.findIndex((i) => i.id === $viewing.imageId) : -1);
  const current = $derived(index >= 0 ? list[index] : null);

  function step(delta: number) {
    if (!$viewing || index < 0) return;
    const next = list[index + delta];
    if (next) viewing.set({ sessionId: $viewing.sessionId, imageId: next.id });
  }

  function close() { viewing.set(null); }

  function onKeydown(e: KeyboardEvent) {
    if (!$viewing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }

  function openPeek() {
    if (!$peek) return;
    viewing.set({ sessionId: $peek.sessionId, imageId: $peek.image.id });
    showImages.set(true);
    peek.set(null);
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if $viewing && current}
  <div class="viewer fade-in" role="dialog" aria-modal="true" aria-label="Image" tabindex="-1">
    <button class="backdrop" onclick={close} aria-label="Close" tabindex="-1"></button>
    <div class="bar">
      <span class="label">{toolLabel(current.tool)} · {index + 1} of {list.length}</span>
      <span class="actions">
        <button class="ghost" onclick={() => step(-1)} disabled={index <= 0} title="Older (←)">‹</button>
        <button class="ghost" onclick={() => step(1)} disabled={index >= list.length - 1} title="Newer (→)">›</button>
        <a class="ghost btnlike" href={imageUrl($viewing.sessionId, current.id)} target="_blank" rel="noopener" title="Open in a new tab">Open</a>
        <button class="ghost" onclick={close} title="Close (Esc)"><Icon name="x" size={14} /></button>
      </span>
    </div>
    <img src={imageUrl($viewing.sessionId, current.id)} alt={toolLabel(current.tool)} />
  </div>
{/if}

{#if $peek && !$viewing}
  <div class="peek fade-in">
    <button class="peek-img" onclick={openPeek} title="View full size">
      <img src={imageUrl($peek.sessionId, $peek.image.id)} alt={toolLabel($peek.image.tool)} />
    </button>
    <div class="peek-row">
      <span>{toolLabel($peek.image.tool)}</span>
      <button class="ghost" onclick={() => peek.set(null)} title="Dismiss"><Icon name="x" size={12} /></button>
    </div>
  </div>
{/if}

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    background: color-mix(in srgb, #000 78%, transparent);
  }
  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: none;
    cursor: zoom-out;
  }
  .bar, .viewer img { position: relative; }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: min(100%, 1400px);
    color: #eee;
    font-size: 13px;
  }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 4px; flex: none; }
  .actions button, .btnlike {
    color: #eee;
    padding: 4px 10px;
    font-size: 15px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    text-decoration: none;
    border-radius: 6px;
  }
  .btnlike { font-size: 12px; }
  .actions button:disabled { opacity: 0.3; }
  .viewer img {
    max-width: min(100%, 1400px);
    max-height: calc(100% - 50px);
    object-fit: contain;
    border-radius: 6px;
    box-shadow: var(--shadow);
    background: #fff;
  }

  .peek {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 12;
    width: 260px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    box-shadow: var(--shadow);
  }
  .peek-img { display: block; width: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }
  .peek-img img { width: 100%; max-height: 170px; object-fit: contain; border-radius: 6px; background: var(--bg); display: block; }
  .peek-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-top: 5px;
    padding: 0 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .peek-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .peek-row button { padding: 2px 4px; display: inline-flex; }
  @media (max-width: 600px) {
    .peek { width: 180px; right: 10px; bottom: 10px; }
  }
</style>
