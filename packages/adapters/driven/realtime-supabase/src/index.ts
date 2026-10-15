/**
 * Presence over Supabase Realtime: the application's PresencePort. The browser never broadcasts:
 * it keeps the learner's latest snapshot in `tutors-connect-latest` and reports the event to the
 * reader's server (POST /api/live/activity), which publishes it only to the feeds a Tutors Live tab
 * is watching, within the day's budget (supabase/migrations/20261016_realtime_live_budget.sql).
 * Subscribing goes through the @tutors/realtime gateway, so the per-tab budget, the jittered
 * rejoin and the counts cover every channel; while the budget is paused a subscriber reads the
 * stored activity instead. This is the only package that drives Supabase Realtime channels
 * (gateway.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PresenceEvent, StoredPresence } from "@tutors/domain/presence";
import type { PresencePort, Unsubscribe } from "@tutors/application/ports";
import { createRealtimeGateway, topics, type RealtimeGateway, type Topic } from "@tutors/realtime";
import log from "@tutors/logger";
import { supabaseRealtimeAdapter } from "./gateway.ts";
import { liveWatcherId, watchLiveTopic } from "./budget.ts";

export { supabaseRealtimeAdapter, realtimeClientOptions } from "./gateway.ts";
export * from "./budget.ts";
export * from "./live-activity.ts";

/** The platform-wide activity feed Tutors Live's landing page subscribes to. */
export const ALL_COURSES_CHANNEL: string = topics.platformActivity();
const LO_EVENT = "lo-event";

/** The reader's server route that publishes learning events to Tutors Live (apps/reader/src/routes/api/live/activity). */
export const LIVE_ACTIVITY_ROUTE = "/api/live/activity";
/** How often a Tutors Live tab reports itself as a watcher, and reads stored activity while it must. */
export const LIVE_WATCH_MS = 60 * 1000;
/** How far back a stored-activity read looks: two reports, so a missed tick loses nothing. */
export const LIVE_STORED_WINDOW_MS = 2 * 60 * 1000;

export type SupabasePresenceOptions = {
  /**
   * How a published event reaches the reader's server. The default posts it to LIVE_ACTIVITY_ROUTE
   * with `keepalive`, so the request finishes when the student is leaving the page; a server-side
   * composition passes its own.
   */
  report?: (event: PresenceEvent) => void;
  /**
   * How the learner's latest snapshot reaches `tutors-connect-latest`. The browser's composition
   * passes the data API's POST /api/presence (the server writes for the session's login, Rule
   * 0072); without one the snapshot is not stored. The browser writes no table itself.
   */
  store?: (event: PresenceEvent) => Promise<void>;
  /** The gateway to subscribe through; one per tab by default, built on this client. */
  gateway?: RealtimeGateway;
};

/** The PresencePort over Supabase, with the gateway it subscribes through (for the counts and tests). */
export interface SupabasePresence extends PresencePort {
  readonly gateway: RealtimeGateway;
}

/** Fire-and-forget: `keepalive` lets the request finish when the student is leaving the page. */
function reportToReaderServer(event: PresenceEvent): void {
  if (typeof fetch !== "function") return;
  try {
    void fetch(LIVE_ACTIVITY_ROUTE, {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    }).catch((error: unknown) => log.warn("Reporting live activity failed:", error));
  } catch (error) {
    log.warn("Reporting live activity failed:", error);
  }
}

/**
 * `now` stamps the stored snapshot; it is the Clock port's value so the harness can freeze it.
 */
export function supabasePresence(client: SupabaseClient, now: () => Date = () => new Date(), options: SupabasePresenceOptions = {}): SupabasePresence {
  const report = options.report ?? reportToReaderServer;
  const gateway =
    options.gateway ??
    createRealtimeGateway({
      adapter: supabaseRealtimeAdapter(client),
      onError: (failure, topic, error) => {
        if (failure === "send") log.error("Realtime broadcast failed:", topic, error);
        else log.error("Leaving a Realtime channel failed:", topic, error);
      }
    });

  async function storeLatest(event: PresenceEvent): Promise<void> {
    const courseId = event.courseId?.trim();
    const studentId = event.user?.id?.trim();
    if (!courseId || !studentId || !options.store) return;
    try {
      await options.store(event);
    } catch (error) {
      log.error("upsertTutorsConnectLatestLo failed:", error);
    }
  }

  async function recentRows(courseId: string | undefined, sinceIso: string): Promise<StoredPresence[] | null> {
    let query = client.from("tutors-connect-latest").select("course_id, student_id, payload, received_at").gte("received_at", sinceIso).order("received_at", { ascending: false });
    if (courseId) query = query.eq("course_id", courseId);
    else query = query.limit(200);
    const { data, error } = await query;
    if (error) {
      if (courseId) log.error("getTutorsConnectRecentLosByCourseId failed:", error);
      else log.error("getTutorsConnectRecentLos failed:", error);
      return null;
    }
    return (data ?? []) as StoredPresence[];
  }

  /**
   * Keeps a feed going alongside its Realtime subscription. Every 60 seconds (and at once) it reports
   * this tab as a watcher of `topic`, which is what makes the reader's server publish to it. When the
   * day's budget is paused, or the report fails (the function missing before its migration, the
   * database unreachable), nothing will be published, so it reads the stored activity instead and
   * hands each record, oldest first, to the listener.
   */
  function watchFeed(topic: Topic, courseId: string | undefined, listener: (event: PresenceEvent) => void): () => void {
    let stopped = false;
    const tick = async () => {
      const tier = await watchLiveTopic(client, topic, liveWatcherId());
      if (stopped || (tier !== null && tier !== "paused")) return;
      const rows = await recentRows(courseId, new Date(now().getTime() - LIVE_STORED_WINDOW_MS).toISOString());
      if (stopped || !rows) return;
      for (const row of [...rows].reverse()) listener(row.payload as PresenceEvent);
    };
    const timer = setInterval(() => void tick(), LIVE_WATCH_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return {
    gateway,

    async publish(event) {
      // The browser publishes nothing over Realtime: the reader's server publishes to Tutors Live, and only
      // to the feeds a Live tab is watching, within the day's budget.
      report(event);
      await storeLatest(event);
    },

    subscribe(listener, courseId): Unsubscribe {
      const topic = courseId ? topics.courseActivity(courseId) : topics.platformActivity();
      const subscription = gateway.subscribe(topic, {
        events: [LO_EVENT],
        onMessage: (_event, payload) => {
          const event = payload as PresenceEvent | undefined;
          if (event) listener(event);
        }
      });
      const stopFeed = watchFeed(topic, courseId, listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        stopFeed();
        void subscription.close();
      };
    },

    async recent(courseId, sinceIso): Promise<StoredPresence[] | null> {
      const id = courseId?.trim();
      if (!id) return [];
      return recentRows(id, sinceIso);
    }
  };
}
