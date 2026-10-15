import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLiveActivity } from "@tutors/domain/presence";
import { topics, type RealtimeAdapter, type Topic } from "@tutors/realtime";
import log from "@tutors/logger";
import { supabaseRealtimeAdapter } from "./gateway.ts";
import type { LiveBudgetTier } from "./budget.ts";

/** The check moved to the domain (both realtime adapters publish what it returns); exported here as before. */
export { MAX_LIVE_ACTIVITY_BYTES, parseLiveActivity } from "@tutors/domain/presence";

/**
 * The reader's server side of Tutors Live (POST /api/live/activity). The browser sends each learning
 * event here instead of broadcasting it; this publishes it only to the Realtime topics a Tutors Live tab
 * is watching, within the day's budget (supabase/migrations/20261016_realtime_live_budget.sql).
 *
 * Each request publishes at once. Batching events over a few seconds needs state that outlives a
 * request, which a Netlify function does not keep; it waits for the reader to run as one long-lived
 * server.
 */

/**
 * Asks the database which Realtime topics a course's learning event may be published to, and charges
 * them to the day's Live budget. Called by the reader's server only.
 * @returns the tier and topics, or null when the claim failed (the caller publishes nothing)
 */
export async function claimLivePublish(client: SupabaseClient, courseId: string): Promise<{ tier: LiveBudgetTier; topics: string[] } | null> {
  const { data, error } = await client.rpc("realtime_claim_live_publish", { p_course_id: courseId });
  if (error) {
    log.warn("realtime_claim_live_publish failed:", error);
    return null;
  }
  const claim = data as { tier?: LiveBudgetTier; topics?: unknown } | null;
  if (!claim?.tier || !Array.isArray(claim.topics)) return null;
  return { tier: claim.tier, topics: claim.topics.filter((topic): topic is string => typeof topic === "string") };
}

/**
 * Reports a Tutors Live tab as a watcher of a Realtime topic, so the reader's server publishes to it
 * (POST /api/live/watch). Called by the reader's server only, with its service client.
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

export type LiveActivityResponse = { status: number; body?: { tier: LiveBudgetTier | null; topics: string[] } | { message: string } };

/** One broker adapter per client, so a long-lived server reuses its channels. */
const adapters = new WeakMap<SupabaseClient, RealtimeAdapter>();

/**
 * Publishes one learning event to the topics the database allows.
 * 400 for a malformed body; 204 with no client (anonymous mode, Supabase unconfigured); otherwise 202 with the tier and the topics published
 * to. A claim that fails (the migration not applied, the database unreachable) publishes nothing.
 */
export async function receiveLiveActivity(raw: string, client: SupabaseClient | undefined): Promise<LiveActivityResponse> {
  const record = parseLiveActivity(raw);
  if (typeof record === "string") return { status: 400, body: { message: record } };
  if (!client) return { status: 204 };

  const claim = await claimLivePublish(client, record.courseId);
  if (!claim) return { status: 202, body: { tier: null, topics: [] } };

  const allowed = new Map<string, Topic>([
    [topics.courseActivity(record.courseId), topics.courseActivity(record.courseId)],
    [topics.platformActivity(), topics.platformActivity()]
  ]);
  const targets = claim.topics.map((topic) => allowed.get(topic)).filter((topic): topic is Topic => topic !== undefined);
  let adapter = adapters.get(client);
  if (!adapter) {
    adapter = supabaseRealtimeAdapter(client);
    adapters.set(client, adapter);
  }
  const results = await Promise.allSettled(targets.map((topic) => adapter.publish(topic, "lo-event", record)));
  results.forEach((result, i) => {
    if (result.status === "rejected") log.error("Live activity broadcast failed:", targets[i], result.reason);
  });
  return { status: 202, body: { tier: claim.tier, topics: targets } };
}
