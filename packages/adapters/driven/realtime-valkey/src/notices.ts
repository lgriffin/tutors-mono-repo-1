import type { CourseNotice, CourseNoticeType, CourseNotices, Unsubscribe } from "@tutors/application/ports";
import { topics, type RealtimeGateway, type Topic } from "@tutors/realtime";
import log from "@tutors/logger";

/**
 * Course notices on Valkey: the application's CourseNotices port. The browser publishes nothing: `post` hands the notice to the
 * reader's server (POST /api/notices), which publishes it with `publishNotice` (server.ts).
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

export type ValkeyCourseNoticesOptions = {
  /** How a posted notice reaches the server; the default posts it to COURSE_NOTICES_ROUTE. */
  post?: (notice: CourseNotice) => Promise<boolean>;
};

/** Watches through `gateway`, whose broker adapter streams from a server (browser.ts). */
export function valkeyCourseNotices(gateway: RealtimeGateway, options: ValkeyCourseNoticesOptions = {}): CourseNotices {
  const post = options.post ?? postToAppServer;
  return {
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
