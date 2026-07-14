<!--
  One xterm instance per session. The DOM node stays mounted even when the tab is
  inactive (hidden via CSS) so client-side scrollback is preserved when switching
  tabs. On mount we `attach` to the server session, which replays its buffer.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { conn } from '../lib/connection';
  import { fontSize } from '../stores/theme';
  import { toast } from '../stores/ui';
  import { resumeSession, restartSession, type Session } from '../stores/sessions';
  import Icon from './Icon.svelte';

  let { session, active }: { session: Session; active: boolean } = $props();

  // A stopped session has no live pty. Show a start/resume overlay over the
  // (empty or exited) terminal so the user has a clear call to action — this is
  // what a restored ghost session lands on after a server restart.
  const showOverlay = $derived(session.status === 'stopped');

  function resume() { const { cols, rows } = dims(); resumeSession(session.id, cols, rows); }
  function startFresh() { const { cols, rows } = dims(); restartSession(session.id, cols, rows); }

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let unsubData: (() => void) | null = null;
  let unsubStatus: (() => void) | null = null;
  let ro: ResizeObserver | null = null;
  let mounted = false;
  let pasteTarget: HTMLTextAreaElement | null = null;

  // xterm owns a hidden <textarea> that intercepts paste (and right-click paste)
  // when the terminal has focus, calling preventDefault before it can bubble to
  // App.svelte's window-level handler. So we listen on that textarea directly,
  // in the capture phase, and grab image pastes before xterm swallows them.
  function readAsBase64(file: Blob): Promise<string> {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
  }

  async function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items ?? [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const blob = it.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (it.type?.startsWith('image/')) {
        // Screenshot / image → image pipeline (.claude-web-images, generic name).
        const ext = (blob.type.split('/')[1] || 'png');
        const data = await readAsBase64(blob);
        conn.send({ type: 'image', id: session.id, data, ext });
        toast('image attached');
      } else {
        // Document (pdf/docx/pptx/xlsx/…) copied from Explorer → file pipeline,
        // which keeps the real filename under .claude-web-files.
        const name = (blob as File).name || 'pasted-file';
        const data = await readAsBase64(blob);
        conn.send({ type: 'file', id: session.id, name, data });
        toast('attaching ' + name + '…');
      }
      return;
    }

    // Plain text: send it ourselves, always wrapped in bracketed-paste markers
    // (ESC[200~ … ESC[201~), instead of letting xterm's own paste handler do
    // it. xterm only wraps pastes when it believes bracketed-paste mode is
    // currently on, tracked from escape codes the CLI has sent so far in this
    // terminal's lifetime — over a long-running session that bookkeeping can
    // end up stuck off (e.g. the CLI toggles it around a dialog and doesn't
    // cleanly restore it), and an unwrapped paste can arrive at the CLI's
    // stdin in several separate OS-level chunks with nothing marking them as
    // one paste — which Claude then renders as multiple garbled
    // "[Pasted text #1]...[Pasted text #2]..." fragments instead of one clean
    // block. Wrapping it explicitly on every paste sidesteps that stuck
    // state entirely (confirmed via a live test: unwrapped, a 1000-line paste
    // split into 4 fragments; wrapped, the same paste arrived as one).
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      e.preventDefault();
      e.stopImmediatePropagation();
      conn.send({ type: 'input', id: session.id, data: '\x1b[200~' + text + '\x1b[201~' });
    }
  }

  function dims() {
    return { cols: term?.cols ?? 120, rows: term?.rows ?? 30 };
  }

  function doFit() {
    if (!mounted || !host || host.offsetParent === null) return;
    try {
      fit.fit();
      const { cols, rows } = dims();
      conn.send({ type: 'resize', id: session.id, cols, rows });
    } catch {}
  }

  onMount(() => {
    term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
      fontSize: $fontSize,
      theme: {
        background: '#1a1816',
        foreground: '#e8e3dc',
        cursor: '#d97757',
        selectionBackground: '#d9775744',
      },
      allowProposedApi: true,
      scrollback: 10000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon()); } catch {}
    term.open(host);
    mounted = true;
    doFit();

    // Keystrokes → server (scoped to this session id).
    term.onData((d) => conn.send({ type: 'input', id: session.id, data: d }));

    // Let Ctrl/Cmd+V reach the browser's native paste instead of xterm turning
    // it into a literal ^V (0x16). Returning false here makes xterm bail out of
    // _keyDown BEFORE it preventDefaults, so a real `paste` event fires on the
    // textarea — which our image handler (below) and xterm's own text-paste
    // handler then receive. (Right-click paste already fires this event.)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey
          && e.key.toLowerCase() === 'v') {
        return false;
      }
      return true;
    });

    // Intercept image paste on xterm's hidden textarea (capture phase) before
    // xterm consumes it. Covers both Ctrl+V and right-click → Paste.
    pasteTarget = term.textarea ?? null;
    pasteTarget?.addEventListener('paste', onPaste, true);

    // Server output for THIS session only.
    unsubData = conn.on((m) => {
      if (m.type === 'data' && m.id === session.id) term.write(m.data);
    });

    // Attach (replays scrollback buffer, then streams live). Re-attach on reconnect.
    const attach = () => {
      const { cols, rows } = dims();
      term.reset();
      conn.send({ type: 'attach', id: session.id, cols, rows });
    };
    unsubStatus = conn.onStatus((s) => { if (s === 'connected') attach(); });

    ro = new ResizeObserver(() => doFit());
    ro.observe(host);
  });

  onDestroy(() => {
    unsubData?.();
    unsubStatus?.();
    ro?.disconnect();
    pasteTarget?.removeEventListener('paste', onPaste, true);
    try { term?.dispose(); } catch {}
  });

  // Live font-size changes.
  $effect(() => {
    const fs = $fontSize;
    if (term) { term.options.fontSize = fs; doFit(); }
  });

  // When this tab becomes active, fit + focus.
  $effect(() => {
    if (active && mounted) {
      requestAnimationFrame(() => { doFit(); term?.focus(); });
    }
  });
</script>

<div class="term-host" class:active bind:this={host}></div>

{#if active && showOverlay}
  <div class="resume-overlay">
    <div class="resume-card slide-up">
      {#if session.resumable}
        <h3>Pick up where you left off</h3>
        <p>A previous Claude conversation was found for <code>{session.title}</code>.</p>
        <div class="actions">
          <button class="primary" onclick={resume}><Icon name="corner-down-left" size={14} /> Resume last conversation</button>
          <button class="ghost" onclick={startFresh}>Start fresh</button>
        </div>
      {:else}
        <h3>Session stopped</h3>
        <p>No saved conversation to resume for <code>{session.title}</code>.</p>
        <div class="actions">
          <button class="primary" onclick={startFresh}><Icon name="play" size={14} /> Start Claude</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .term-host {
    position: absolute;
    inset: 0;
    padding: 8px 10px;
    display: none;
  }
  .term-host.active { display: block; }
  :global(.term-host .xterm) { height: 100%; }

  .resume-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg) 78%, transparent);
    backdrop-filter: blur(2px);
  }
  .resume-card {
    text-align: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 28px 34px;
    max-width: 440px;
  }
  .resume-card h3 { margin: 0 0 8px; color: var(--text); }
  .resume-card p { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  .resume-card code {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    color: var(--text);
  }
  .actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  .actions button { display: inline-flex; align-items: center; gap: 6px; }
  .actions .primary { font-size: 13px; padding: 8px 16px; }
  .actions .ghost { font-size: 13px; padding: 8px 14px; }
</style>
