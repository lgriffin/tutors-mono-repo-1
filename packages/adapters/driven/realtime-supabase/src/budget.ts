/**
 * Tutors Live's daily Realtime budget, as the database holds it (supabase/migrations/20261016_realtime_live_budget.sql):
 * a Live tab reports what it watches, the reader's server claims what it may publish.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import log from "@tutors/logger";

/** How much of the day's Live Realtime budget is spent: under 70%, from 70%, from 90%. */
export type LiveBudgetTier = "normal" | "slow" | "paused";

let watcherId = "";

/** This tab's watcher id: random, so two Live tabs of one person count as two watchers. */
export function liveWatcherId(): string {
  if (!watcherId) watcherId = crypto.randomUUID();
  return watcherId;
}

/**
 * Reports a Tutors Live tab as a watcher of a Realtime topic, so the reader's server publishes to it.
 * @returns the day's budget tier, or null when the report failed (including before the migration is applied)
 */
export async function watchLiveTopic(client: SupabaseClient, topic: string, watcher: string): Promise<LiveBudgetTier | null> {
  const { data, error } = await client.rpc("realtime_watch", { p_topic: topic, p_watcher: watcher });
  if (error) {
    log.warn("realtime_watch failed:", error);
    return null;
  }
  const tier = (data as { tier?: string } | null)?.tier;
  return tier === "normal" || tier === "slow" || tier === "paused" ? tier : null;
}
