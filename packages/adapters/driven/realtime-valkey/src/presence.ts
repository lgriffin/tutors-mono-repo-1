/**
 * Presence on Valkey: the application's PresencePort. The browser never publishes over the stream:
 * it hands the learner's latest snapshot to the data API (POST /api/presence) and reports the
 * event to the reader's server (POST /api/live/activity), which publishes it to the course's and the
 * platform's activity topics. A Tutors Live tab subscribes through the @tutors/realtime gateway, so
 * the per-tab budget, the jittered rejoin and the counts cover the stream. There is no daily budget,
 * no watcher report and no paused tier: a Live tab streams and never falls back to polling the roster.
 */
import type { PresenceEvent, StoredPresence } from "@tutors/domain/presence";
import type { PresencePort, Unsubscribe } from "@tutors/application/ports";
import { topics, type RealtimeGateway } from "@tutors/realtime";
import log from "@tutors/logger";
import { LO_EVENT } from "./server.ts";

/** The reader's server route that publishes learning events to Tutors Live. */
const LIVE_ACTIVITY_ROUTE = "/api/live/activity";

export type ValkeyPresenceOptions = {
  /** How a published event reaches the reader's server; the default posts it to LIVE_ACTIVITY_ROUTE with `keepalive`. */
  report?: (event: PresenceEvent) => void;
  /** How the learner's latest snapshot is stored (the data API's POST /api/presence); without one it is not. */
  store?: (event: PresenceEvent) => Promise<void>;
  /** The stored roster (the data API's GET /api/presence/roster); null when the read failed. */
  roster?: (courseId: string | undefined, sinceIso: string) => Promise<StoredPresence[] | null>;
};

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

export function valkeyPresence(gateway: RealtimeGateway, options: ValkeyPresenceOptions = {}): PresencePort {
  const report = options.report ?? reportToReaderServer;

  async function storeLatest(event: PresenceEvent): Promise<void> {
    if (!event.courseId?.trim() || !event.user?.id?.trim() || !options.store) return;
    try {
      await options.store(event);
    } catch (error) {
      log.error("Storing the latest presence snapshot failed:", error);
    }
  }

  return {
    async publish(event) {
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
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        void subscription.close();
      };
    },

    async recent(courseId, sinceIso): Promise<StoredPresence[] | null> {
      const id = courseId?.trim();
      if (!id) return [];
      return options.roster ? options.roster(id, sinceIso) : null;
    }
  };
}
