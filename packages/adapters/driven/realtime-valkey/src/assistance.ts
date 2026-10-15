/**
 * The Assistance context's feed on Valkey: a course's help queue changes travel on the topic
 * `assistance:<courseId>`. The reader's server publishes each change after it is stored
 * (POST /api/assistance, Rule 0391); only the reader's server streams the topic, and only to a
 * signed-in educator of the course (GET /api/realtime/stream, Rule 0392), so Tutors Live's course
 * page opens the stream on the reader's origin with the lecturer's session. A student's reader never
 * joins it: their own request is read from stored rows.
 */
import type { AssistanceChange, AssistanceFeed, Unsubscribe } from "@tutors/application/ports";
import type { Topic } from "@tutors/realtime";
import log from "@tutors/logger";
import type { RealtimeHub } from "./hub.ts";
import { REALTIME_STREAM_ROUTE, type EventSourceLike } from "./browser.ts";
import { courseIdOf } from "./topics.ts";

const PREFIX = "assistance:";

/** The topic a course's help queue changes travel on. */
export function assistanceTopic(courseId: string): Topic {
  return `${PREFIX}${courseId}` as Topic;
}

/** The course of an assistance topic, or null for any other topic. */
export function assistanceCourseOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith(PREFIX)) return null;
  return courseIdOf(raw.slice(PREFIX.length));
}

function isChange(value: unknown): value is AssistanceChange {
  const change = value as Partial<AssistanceChange> | null;
  return !!change && typeof change.courseId === "string" && (change.type === "help-request" || change.type === "annotation");
}

/**
 * The server's feed over the hub: `publish` sends a change to its course's topic and resolves
 * false, logging, when there is no hub (anonymous mode, Supabase Realtime) or Valkey failed. `watch`
 * hears a course's changes in this process, as the stream route does for each browser.
 */
export function valkeyAssistanceFeed(hub: RealtimeHub | null): AssistanceFeed {
  return {
    async publish(change) {
      if (!hub || !change.courseId) return false;
      try {
        await hub.publish(assistanceTopic(change.courseId), { event: change.type, payload: change });
        return true;
      } catch (error) {
        log.error("Publishing a help queue change failed:", change.courseId, error);
        return false;
      }
    },
    watch(courseId, listener) {
      if (!hub) return () => {};
      let stopped = false;
      const unsubscribe = hub
        .subscribe(assistanceTopic(courseId), (message) => {
          if (!stopped && isChange(message.payload) && message.payload.courseId === courseId) listener(message.payload);
        })
        .catch((error: unknown) => {
          log.error("Watching a help queue failed:", courseId, error);
          return async () => {};
        });
      return () => {
        stopped = true;
        void unsubscribe.then((stop) => stop());
      };
    }
  };
}

export type SseAssistanceFeedOptions = {
  /** The reader's origin, which streams the queue; "" for the reader's own pages. */
  streamBase?: string;
  /** Opens a stream with the lecturer's session; a test hands it a fake. */
  eventSource?: (url: string) => EventSourceLike;
};

/** A server render has no EventSource: nothing is heard. */
function openWithSession(url: string): EventSourceLike {
  if (typeof EventSource === "undefined") return { onopen: null, onmessage: null, onerror: null, close: () => {} };
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

/**
 * The browser's feed for an educator's page (Tutors Live's course page): `watch` streams the
 * course's queue from the reader's server with the session cookie; a browser never publishes, so
 * `publish` resolves false. A stream that drops reconnects on its own (EventSource's retry); one the
 * reader refuses (not an educator) stays closed, and the page reads the queue from stored rows
 * (GET /api/assistance) either way.
 */
export function sseAssistanceFeed(options: SseAssistanceFeedOptions = {}): AssistanceFeed {
  const open = options.eventSource ?? openWithSession;
  let end = (options.streamBase ?? "").length;
  while (end > 0 && options.streamBase![end - 1] === "/") end--;
  const base = (options.streamBase ?? "").slice(0, end);
  return {
    publish: async () => false,
    watch(courseId, listener): Unsubscribe {
      const source = open(`${base}${REALTIME_STREAM_ROUTE}?topic=${encodeURIComponent(assistanceTopic(courseId))}`);
      let closed = false;
      source.onmessage = (frame) => {
        if (closed) return;
        try {
          const message = JSON.parse(frame.data) as { payload?: unknown } | null;
          if (isChange(message?.payload) && message.payload.courseId === courseId) listener(message.payload);
        } catch {
          // Not a frame the reader sends.
        }
      };
      return () => {
        closed = true;
        source.close();
      };
    }
  };
}
