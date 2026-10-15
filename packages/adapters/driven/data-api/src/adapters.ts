/**
 * The application ports over the data API: what the reader's browser composition installs for a
 * signed-in deployment. Each one sends the request; the reader's server verifies the session and
 * writes for its login (Rules 0071, 0072). Nothing here reads or writes a table.
 */
import { courseVisitOf, onlineStatusFor, parseSentiment, parseSharing, type CourseVisit, type PresenceEvent } from "@tutors/domain/presence";
import type { Course } from "@tutors/domain/course";
import type { AccessStore, LearningEventSink, ProfilePort, WhiteboardStore } from "@tutors/application/ports";
import { dataApi, type DataApi } from "./client.ts";

/** POST /api/analytics for each learning event; the learner is the session, so `learnerId` is not sent. */
export function readerApiLearningEventSink(api: DataApi = dataApi): LearningEventSink {
  return {
    async record(event, learnerId) {
      if (!learnerId || !event.courseId) return;
      if (event.kind === "page-load") {
        if (!event.loId) return;
        await api.recordAnalytics({ kind: "page-load", courseId: event.courseId, loId: event.loId, loType: event.loType, day: event.day });
      } else {
        await api.recordAnalytics({ kind: "tick", courseId: event.courseId, loId: event.loId, day: event.day });
      }
    }
  };
}

/** A response other than success, 401 (not signed in) or 503 (no database on the server) is a failure worth reporting. */
function failed(response: Response | null): boolean {
  return !!response && !response.ok && response.status !== 401 && response.status !== 503;
}

/** The signed-in learner's record through /api/me and /api/profile. */
export function readerApiProfile(api: DataApi = dataApi): ProfilePort {
  return {
    async getCourseVisits(learnerId) {
      if (!learnerId) return [];
      return (await api.getProfile<CourseVisit>())?.courseVisits ?? [];
    },
    async saveCourseVisits(learnerId, visits) {
      if (!learnerId) return;
      const response = await api.saveProfile({ courseVisits: visits });
      if (failed(response)) throw new Error(`Saving the profile failed with status ${response!.status}`);
    },
    async upsertLearner(profile) {
      if (!profile.login) return;
      const change: { sentiment?: string; onlineStatus?: "online" | "offline" } = {};
      const sentiment = parseSentiment(profile.sentiment);
      if (sentiment) change.sentiment = sentiment;
      if (profile.sharing !== null) change.onlineStatus = onlineStatusFor(profile.sharing);
      const response = await api.saveMe(change);
      if (failed(response)) throw new Error(`Saving the student record failed with status ${response!.status}`);
    },
    async getSentiment(learnerId) {
      if (!learnerId) return null;
      return parseSentiment((await api.getMyStatus())?.sentiment);
    },
    async setSentiment(learnerId, sentiment) {
      if (!learnerId) return;
      const response = await api.changeMyStatus({ sentiment });
      if (failed(response)) throw new Error(`Saving the sentiment failed with status ${response!.status}`);
    },
    async getSharing(learnerId) {
      if (!learnerId) return null;
      return parseSharing((await api.getMyStatus())?.online_status);
    },
    async setSharing(learnerId, sharing) {
      if (!learnerId) return;
      const response = await api.changeMyStatus({ onlineStatus: onlineStatusFor(sharing) });
      if (failed(response)) throw new Error(`Saving the online status failed with status ${response!.status}`);
    }
  };
}

/**
 * Locks are changed through /api/locks (the server checks the actor is an educator, Rule 0065);
 * `locks` is the public read the browser already has (the store's, with the anon key).
 */
export function readerApiAccessStore(locks: AccessStore["locks"], api: DataApi = dataApi): AccessStore {
  return {
    locks,
    async setLock(courseId, loRoute, locked) {
      if (!courseId || !loRoute) return false;
      return (await api.setLock({ courseId, loRoute, locked }))?.ok ?? false;
    },
    async removeLock(courseId, loRoute) {
      if (!courseId || !loRoute) return false;
      return (await api.removeLock({ courseId, loRoute }))?.ok ?? false;
    }
  };
}

/** Whiteboard scenes through /api/whiteboard; a personal room is the session's own, so `owner` is not sent. */
export function readerApiWhiteboardStore(api: DataApi = dataApi): WhiteboardStore {
  return {
    async load(room, owner) {
      if (!room.shared && !owner) return null;
      return (await api.getWhiteboard(room))?.scene ?? null;
    },
    async save(room, owner, elements) {
      if (!room.shared && !owner) return false;
      return (await api.saveWhiteboard({ ...room, elements }))?.ok ?? false;
    }
  };
}

/** The learner's latest snapshot, stored by the server under the session's login (POST /api/presence). */
export function readerApiPresenceStore(api: DataApi = dataApi): (event: PresenceEvent) => Promise<void> {
  return async (event) => {
    const courseId = event.courseId?.trim();
    if (!courseId) return;
    await api.reportPresence({ courseId, payload: event });
  };
}

/** A course visit for the catalogue (POST /api/courses/visit); the server takes the title and credits from the published course. */
export function readerApiCourseVisit(api: DataApi = dataApi): (course: Course, now: Date) => Promise<void> {
  return async (course, now) => {
    const { visits: _visits, ...record } = courseVisitOf(course, now);
    await api.reportCourseVisit({ courseId: course.courseId, courseRecord: { ...record, private: course.isPrivate } });
  };
}
