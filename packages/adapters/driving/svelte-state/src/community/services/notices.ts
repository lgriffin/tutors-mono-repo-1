/**
 * Course notices as the UI sees them: a lecturer's broadcast to the students reading a course
 * (issue #78) and the content-free ping that tells a course's educators a snippet was shared
 * (issue #155). Plain TypeScript, no runes, so it runs under vitest without the Svelte compiler.
 *
 * Each tab shows a notice once. The gateway shares one channel per topic, so a notice normally
 * arrives once; the id guard covers a rejoin that replays, or a sender hearing its own echo.
 */
import type { BroadcastMessage } from "@tutors/application";
import { broadcastToCourse, createBroadcastLimiter } from "@tutors/application";
import type { CourseNotice, CourseNoticeType, LecturerBroadcast, SnippetSharedNotice, Unsubscribe } from "@tutors/application/ports";
import { adapters } from "../../adapters.ts";

/** How many "already shown" ids to remember per course before the oldest is forgotten. */
const MAX_SEEN_IDS = 256;
const seen = new Map<string, Set<string>>();

function firstTime(courseId: string, type: CourseNoticeType, id: string): boolean {
  const key = `${courseId}\t${type}`;
  const ids = seen.get(key) ?? new Set<string>();
  seen.set(key, ids);
  if (ids.has(id)) return false;
  ids.add(id);
  if (ids.size > MAX_SEEN_IDS) ids.delete(ids.values().next().value as string);
  return true;
}

type Handler = (notice: CourseNotice) => void;
type Watchers = { handlers: Set<Handler>; stop: Unsubscribe };
/** One adapter subscription per course and type; every handler in the tab hears each notice once. */
const watchers = new Map<string, Watchers>();

function watch<T extends CourseNotice>(courseId: string, type: T["type"], handler: (notice: T) => void): Unsubscribe {
  if (!courseId || adapters().anonymous) return () => {};
  const key = `${courseId}\t${type}`;
  let watching = watchers.get(key);
  if (!watching) {
    const handlers = new Set<Handler>();
    const stop = adapters().notices.watch(courseId, type, (notice) => {
      if (!firstTime(courseId, type, notice.id)) return;
      for (const h of handlers) {
        try {
          h(notice);
        } catch {
          /* A broken listener must never take down the delivery loop. */
        }
      }
    });
    watching = { handlers, stop };
    watchers.set(key, watching);
  }
  const typed = handler as Handler;
  watching.handlers.add(typed);
  return () => {
    const current = watchers.get(key);
    if (!current) return;
    current.handlers.delete(typed);
    if (current.handlers.size === 0) {
      watchers.delete(key);
      current.stop();
    }
  };
}

/** The browser's own limiter: the server holds the one that counts, this one spares a round trip. */
let limiter = createBroadcastLimiter();

export const noticeService = {
  /** Hear a lecturer's broadcasts to a course, each once per tab. Returns the unsubscribe. */
  onLecturerBroadcast(courseId: string, handler: (broadcast: LecturerBroadcast) => void): Unsubscribe {
    return watch<LecturerBroadcast>(courseId, "course:broadcast", handler);
  },

  /** Hear the "a snippet was shared" pings of a course, each once per tab. Returns the unsubscribe. */
  onSnippetShared(courseId: string, handler: (notice: SnippetSharedNotice) => void): Unsubscribe {
    return watch<SnippetSharedNotice>(courseId, "gist-created", handler);
  },

  /**
   * Send a lecturer's message to every student reading the course. The reader's server checks the
   * sender is an educator and holds the one-per-minute limit; this answers false when it refused.
   */
  async sendLecturerBroadcast(courseId: string, message: BroadcastMessage, senderName: string): Promise<boolean> {
    if (adapters().anonymous) return false;
    const result = await broadcastToCourse({ notices: adapters().notices, clock: adapters().clock, limiter })(courseId, message, senderName);
    return result.ok;
  },

  /** Forget what this tab has shown and sent; tests call it between scenarios. */
  reset(): void {
    for (const watching of watchers.values()) watching.stop();
    watchers.clear();
    seen.clear();
    limiter = createBroadcastLimiter();
  }
};
