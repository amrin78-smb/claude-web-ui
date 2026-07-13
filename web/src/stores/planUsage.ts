import { writable } from 'svelte/store';

export type UsageWindow = {
  percent: number;
  resetsAt: number | null;
  severity: string | null;
};

export type PlanUsage = {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  spend: { percent: number; usedMinor: number; currency: string } | null;
};

export const planUsage = writable<PlanUsage | null>(null);
// Set once a fetch fails, so the UI can hide the widget rather than show stale data.
export const planUsageError = writable<string | null>(null);

const POLL_MS = 60_000;

async function refresh() {
  try {
    const res = await fetch('/api/plan-usage');
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    planUsage.set(await res.json());
    planUsageError.set(null);
  } catch (err) {
    planUsageError.set(err instanceof Error ? err.message : String(err));
  }
}

refresh();
setInterval(refresh, POLL_MS);
