<script lang="ts">
  import { planUsage, planUsageError } from '../stores/planUsage';
  import type { UsageWindow } from '../stores/planUsage';

  function resetLabel(resetsAt: number | null): string {
    if (!resetsAt) return '';
    const ms = resetsAt - Date.now();
    if (ms <= 0) return 'resets soon';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return `resets in ${hours}h${rem ? ` ${rem}m` : ''}`;
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }

  function barColor(w: UsageWindow): string {
    if (w.severity && w.severity !== 'normal') return 'var(--danger)';
    if (w.percent >= 90) return 'var(--danger)';
    return 'var(--accent)';
  }
</script>

{#if $planUsage && ($planUsage.fiveHour || $planUsage.sevenDay)}
  <div class="plan-usage">
    {#if $planUsage.fiveHour}
      <div class="row">
        <div class="label-row">
          <span class="label">5-hour limit</span>
          <span class="pct">{Math.round($planUsage.fiveHour.percent)}%</span>
        </div>
        <div class="bar">
          <div
            class="fill"
            style={`width: ${Math.min(100, $planUsage.fiveHour.percent)}%; background: ${barColor($planUsage.fiveHour)}`}
          ></div>
        </div>
        <div class="reset">{resetLabel($planUsage.fiveHour.resetsAt)}</div>
      </div>
    {/if}

    {#if $planUsage.sevenDay}
      <div class="row">
        <div class="label-row">
          <span class="label">Weekly limit</span>
          <span class="pct">{Math.round($planUsage.sevenDay.percent)}%</span>
        </div>
        <div class="bar">
          <div
            class="fill"
            style={`width: ${Math.min(100, $planUsage.sevenDay.percent)}%; background: ${barColor($planUsage.sevenDay)}`}
          ></div>
        </div>
        <div class="reset">{resetLabel($planUsage.sevenDay.resetsAt)}</div>
      </div>
    {/if}
  </div>
{:else if $planUsageError}
  <div class="plan-usage error" title={$planUsageError}>Plan usage unavailable</div>
{/if}

<style>
  .plan-usage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 6px 2px;
    border-top: 1px solid var(--border);
    flex: none;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .pct {
    font-size: 11px;
    font-weight: 600;
    color: var(--text);
  }

  .bar {
    height: 5px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: 999px;
    transition: width 0.3s ease;
  }

  .reset {
    font-size: 10px;
    color: var(--muted);
  }

  .plan-usage.error {
    padding: 8px 6px;
    font-size: 11px;
    color: var(--muted);
    cursor: default;
  }
</style>
