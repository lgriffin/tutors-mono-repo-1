/**
 * Tutors Live's daily Realtime budget, as the database holds it (supabase/migrations/20261016_realtime_live_budget.sql):
 * a Live tab reports what it watches (POST /api/live/watch), the reader's server claims what it may
 * publish. Both database calls are the server's (live-activity.ts).
 */

/** How much of the day's Live Realtime budget is spent: under 70%, from 70%, from 90%. */
export type LiveBudgetTier = "normal" | "slow" | "paused";

let watcherId = "";

/** This tab's watcher id: random, so two Live tabs of one person count as two watchers. */
export function liveWatcherId(): string {
  if (!watcherId) watcherId = crypto.randomUUID();
  return watcherId;
}
