import type { SupabaseClient } from "@supabase/supabase-js";
import type { CourseNotice, CourseNoticeType, CourseNotices, Unsubscribe } from "@tutors/application/ports";
import { createRealtimeGateway, topics, type RealtimeAdapter, type RealtimeGateway, type Topic } from "@tutors/realtime";
import log from "@tutors/logger";
import { supabaseRealtimeAdapter } from "./gateway.ts";

/**
 * Course notices over Supabase Realtime: the application's CourseNotices port. A notice has its own
 * topic per course and type, so a dashboard that wants snippet pings does not also receive the
 * course's activity feed. The browser publishes nothing: `post` hands the notice to the app's own
 * server (POST /api/notices), which publishes it with `publishCourseNotice`.
 *
 * TODO(budget): these publishes are bounded by the application's rate limits (3 snippets per learner
 * per hour, 1 broadcast per course per minute) rather than claimed against the day's Live budget,
 * whose claim function knows only the activity topics (supabase/migrations/20261016_realtime_live_budget.sql).
 */

/** The reader's server route that publishes course notices. */
export const COURSE_NOTICES_ROUTE = "/api/notices";

const EVENTS: Record<CourseNoticeType, string> = { "gist-created": "gist-created", "course:broadcast": "course-broadcast" };

export function noticeTopic(courseId: string, type: CourseNoticeType): Topic {
  return type === "gist-created" ? topics.courseSnippets(courseId) : topics.courseBroadcasts(courseId);
}

export function noticeEvent(type: CourseNoticeType): string {
  return EVENTS[type];
}

export function isCourseNotice(value: unknown, courseId: string, type: CourseNoticeType): value is CourseNotice {
  const n = value as Partial<CourseNotice> | null;
  if (!n || n.type !== type || n.courseId !== courseId || typeof n.id !== "string" || !n.id || typeof n.sentAt !== "number") return false;
  if (n.type === "course:broadcast") {
    const b = n as Partial<Extract<CourseNotice, { type: "course:broadcast" }>>;
    return typeof b.title === "string" && b.title.length > 0 && typeof b.description === "string" && b.description.length > 0 && typeof b.senderName === "string";
  }
  return true;
}

/** One broker adapter per client, so a long-lived server reuses its channels. */
const adapters = new WeakMap<SupabaseClient, RealtimeAdapter>();

/** Server side: publishes one notice to its course topic over REST, never joining the topic. */
export async function publishCourseNotice(client: SupabaseClient | undefined, notice: CourseNotice): Promise<boolean> {
  if (!client || !notice.courseId) return false;
  let adapter = adapters.get(client);
  if (!adapter) {
    adapter = supabaseRealtimeAdapter(client);
    adapters.set(client, adapter);
  }
  try {
    await adapter.publish(noticeTopic(notice.courseId, notice.type), noticeEvent(notice.type), notice);
    return true;
  } catch (error) {
    log.error("Publishing a course notice failed:", notice.type, notice.courseId, error);
    return false;
  }
}

/** Fire-and-forget to the app's server; the server answers 202 when it published. */
async function postToAppServer(notice: CourseNotice): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  try {
    const response = await fetch(COURSE_NOTICES_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) });
    return response.ok;
  } catch (error) {
    log.warn("Posting a course notice failed:", error);
    return false;
  }
}

export type SupabaseCourseNoticesOptions = {
  /** How a posted notice reaches the server; the default posts it to COURSE_NOTICES_ROUTE. */
  post?: (notice: CourseNotice) => Promise<boolean>;
  /** The gateway to subscribe through; one per tab by default, built on this client. */
  gateway?: RealtimeGateway;
};

export interface SupabaseCourseNotices extends CourseNotices {
  readonly gateway: RealtimeGateway;
}

export function supabaseCourseNotices(client: SupabaseClient, options: SupabaseCourseNoticesOptions = {}): SupabaseCourseNotices {
  const post = options.post ?? postToAppServer;
  const gateway =
    options.gateway ??
    createRealtimeGateway({
      adapter: supabaseRealtimeAdapter(client),
      onError: (failure, topic, error) => {
        if (failure === "send") log.error("Realtime broadcast failed:", topic, error);
        else log.error("Leaving a Realtime channel failed:", topic, error);
      }
    });
  return {
    gateway,
    async post(notice) {
      if (!notice.courseId) return false;
      return post(notice);
    },
    watch(courseId, type, listener): Unsubscribe {
      const subscription = gateway.subscribe(noticeTopic(courseId, type), {
        events: [noticeEvent(type)],
        onMessage: (_event, payload) => {
          if (isCourseNotice(payload, courseId, type)) listener(payload);
        }
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        void subscription.close();
      };
    }
  };
}
