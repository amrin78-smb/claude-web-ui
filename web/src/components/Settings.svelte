<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { config, saveConfig } from '../stores/config';
  import { theme, fontSize, type Theme } from '../stores/theme';
  import { showSettings, toast } from '../stores/ui';
  import { notificationsEnabled, soundEnabled, requestNotifications } from '../lib/notify';
  import { conn, type ConnStatus } from '../lib/connection';
  import Icon from './Icon.svelte';

  // Initialize local form state from the current config snapshot.
  let repoUrl = $state($config.repoUrl);
  let branch = $state($config.branch);
  let autoSync = $state($config.autoSync);

  // ---- app self-update ----
  type UpdatePhase = 'idle' | 'confirm' | 'running' | 'ok' | 'error';
  let updatePhase = $state<UpdatePhase>('idle');
  let updateLog = $state('');
  let updateMessage = $state('');
  let connStatus = $state<ConnStatus>('connecting');
  let awaitingReconnect = $state(false);

  function askUpdate() {
    updatePhase = 'confirm';
  }

  function cancelUpdate() {
    updatePhase = 'idle';
  }

  function updateBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) cancelUpdate();
  }

  function confirmUpdate() {
    updateLog = '';
    updateMessage = '';
    awaitingReconnect = false;
    updatePhase = 'running';
    conn.send({ type: 'update' });
  }

  function closeUpdatePanel() {
    updatePhase = 'idle';
  }

  // Once the server tells us the update succeeded, it's about to restart —
  // watch the existing reconnecting-WebSocket status for the drop-then-reconnect
  // and auto-close the panel once the new process is back up.
  $effect(() => {
    if (updatePhase !== 'ok') return;
    if (connStatus !== 'connected') {
      awaitingReconnect = true;
    } else if (awaitingReconnect) {
      awaitingReconnect = false;
      updatePhase = 'idle';
      toast('update successful — app restarted');
    }
  });

  let unsubUpdateMsg: (() => void) | null = null;

  onMount(() => {
    unsubUpdateMsg = conn.on((m) => {
      if (m.type === 'updatestart') {
        updateLog = '';
        updateMessage = '';
        updatePhase = 'running';
      } else if (m.type === 'updatelog') {
        updateLog += m.data ?? '';
      } else if (m.type === 'updatedone') {
        updateMessage = m.message || '';
        updatePhase = m.ok ? 'ok' : 'error';
      }
    });
    return conn.onStatus((s) => (connStatus = s));
  });

  onDestroy(() => {
    unsubUpdateMsg?.();
  });

  const themes: { value: Theme; label: string }[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ];

  function close() {
    showSettings.set(false);
  }

  function backdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function save() {
    saveConfig({ repoUrl: repoUrl.trim(), branch: branch.trim(), autoSync });
    toast('settings saved');
    close();
  }

  // Requesting the OS permission is async and may be denied — reflect the
  // resulting store value rather than assuming the checkbox click succeeded.
  async function onNotifToggle(e: Event) {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    if (checked) await requestNotifications();
    else notificationsEnabled.set(false);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" onclick={backdrop}>
  <div class="modal">
    <h3>Settings</h3>

    <div class="form-body">
      <section>
        <div class="eyebrow">GitHub sync</div>

        <div class="field">
          <label for="set-repo">Repository URL</label>
          <input
            id="set-repo"
            type="text"
            placeholder="https://github.com/you/repo.git"
            bind:value={repoUrl}
          />
        </div>

        <div class="field">
          <label for="set-branch">Branch</label>
          <input
            id="set-branch"
            type="text"
            placeholder="main (leave blank for default)"
            bind:value={branch}
          />
        </div>

        <div class="field">
          <label class="check-row" for="set-autosync">
            <input id="set-autosync" type="checkbox" bind:checked={autoSync} />
            Auto-sync on open
          </label>
          <div class="hint">
            Pulls/clones the repo into the working folder each time a session opens.
          </div>
        </div>
      </section>

      <section>
        <div class="eyebrow">Appearance</div>

        <div class="field">
          <label for="set-theme">Theme</label>
          <div class="theme-row" role="group" aria-label="Theme">
            {#each themes as t}
              <button
                type="button"
                class:active={$theme === t.value}
                onclick={() => theme.set(t.value)}
              >
                {t.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="field">
          <label for="set-font">Font size</label>
          <div class="font-row">
            <input
              id="set-font"
              type="range"
              min="10"
              max="22"
              step="1"
              value={$fontSize}
              oninput={(e) => fontSize.set(Number(e.currentTarget.value))}
            />
            <span class="font-value">{$fontSize}px</span>
          </div>
        </div>
      </section>

      <section>
        <div class="eyebrow">Notifications</div>

        <div class="field">
          <label class="check-row" for="set-notif">
            <input id="set-notif" type="checkbox" checked={$notificationsEnabled} onchange={onNotifToggle} />
            Desktop notification when a session finishes
          </label>
          <div class="hint">Lets a background session tell you it's done, even in another tab.</div>
        </div>

        <div class="field">
          <label class="check-row" for="set-sound">
            <input id="set-sound" type="checkbox" bind:checked={$soundEnabled} />
            Play a sound too
          </label>
        </div>
      </section>

      <section>
        <div class="eyebrow">App</div>

        <div class="field">
          <button type="button" onclick={askUpdate} disabled={updatePhase !== 'idle'}>
            Update app
          </button>
          <div class="hint">
            Pulls the latest code, reinstalls dependencies, rebuilds, and restarts the server.
          </div>
        </div>
      </section>
    </div>

    <div class="modal-actions">
      <button type="button" onclick={close}>Cancel</button>
      <button type="button" class="primary" onclick={save}>Save</button>
    </div>
  </div>
</div>

{#if updatePhase === 'confirm'}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="overlay" onclick={updateBackdrop}>
    <div class="modal update-modal">
      <h3>Update app?</h3>
      <div class="form-body">
        <p>
          This pulls the latest code, reinstalls dependencies, rebuilds, and restarts the
          server. Every open Claude session will disconnect — you'll be able to resume them
          afterward, but nothing in progress right now will keep streaming. Continue?
        </p>
      </div>
      <div class="modal-actions">
        <button type="button" onclick={cancelUpdate}>Cancel</button>
        <button type="button" class="primary" onclick={confirmUpdate}>Update</button>
      </div>
    </div>
  </div>
{/if}

{#if updatePhase === 'running' || updatePhase === 'ok' || updatePhase === 'error'}
  <div class="overlay">
    <div class="modal update-modal">
      <h3>
        {#if updatePhase === 'running'}
          Updating app…
        {:else if updatePhase === 'ok'}
          Update complete
        {:else}
          Update failed
        {/if}
      </h3>
      <div class="form-body">
        {#if updatePhase === 'running'}
          <div class="update-status">
            <span class="spin"><Icon name="refresh" size={14} /></span>
            Updating — pulling code, installing dependencies, rebuilding…
          </div>
        {:else if updatePhase === 'ok'}
          <div class="update-status">
            <span class="spin"><Icon name="refresh" size={14} /></span>
            Update complete — restarting… {awaitingReconnect ? 'reconnecting…' : ''}
          </div>
        {:else}
          <div class="update-status error">
            {updateMessage || 'Update failed.'} Nothing was restarted — this session is unaffected.
          </div>
        {/if}
        <pre class="update-log">{updateLog || '…'}</pre>
      </div>
      <div class="modal-actions">
        {#if updatePhase === 'error'}
          <button type="button" onclick={closeUpdatePanel}>Close</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .form-body {
    padding: 16px 18px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  section:not(:first-child) {
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field label {
    font-size: 12px;
    color: var(--muted);
  }

  .field input[type='text'] {
    width: 100%;
  }

  .check-row {
    flex-direction: row !important;
    align-items: center;
    gap: 8px;
    color: var(--text) !important;
    font-size: 13px !important;
    cursor: pointer;
  }

  .check-row input[type='checkbox'] {
    accent-color: var(--accent);
    cursor: pointer;
  }

  .hint {
    font-size: 12px;
    color: var(--muted);
  }

  .theme-row {
    display: flex;
    gap: 8px;
  }

  .theme-row button {
    flex: 1;
  }

  .theme-row button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .font-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .font-row input[type='range'] {
    flex: 1;
    accent-color: var(--accent);
  }

  .font-value {
    font-size: 13px;
    color: var(--text);
    min-width: 42px;
    text-align: right;
  }

  .update-modal {
    width: min(520px, 92vw);
  }

  .update-modal p {
    margin: 0;
    font-size: 13px;
    color: var(--text);
    line-height: 1.5;
  }

  .update-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text);
  }

  .update-status.error {
    color: var(--danger);
  }

  .update-log {
    margin: 0;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--muted);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
