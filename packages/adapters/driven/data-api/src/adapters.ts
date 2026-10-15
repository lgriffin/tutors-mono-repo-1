/**
 * The application ports over the data API: what the browser compositions install for a deployment
 * with a database. Each one sends the request; the reader's server verifies the session and reads or
 * writes for its login (Rules 0071, 0072, 0473). Nothing here reads or writes a table.
 */
import { courseVisitOf, onlineStatusFor, parseSentiment, parseSharing, type CourseVisit, type PresenceEvent, type StoredPresence } from "@tutors/domain/presence";
import type { Course } from "@tutors/domain/course";
import type { AccessStore, LearningEventSink, PlaygroundSnapshots, ProfilePort, ScormRecords, WhiteboardStore } from "@tutors/application/ports";
import log from "@tutors/logger";
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

/** Locks are read (GET) and changed (PUT, DELETE: the server checks the actor is an educator, Rule 0065) through /api/locks. */
export function readerApiAccessStore(api: DataApi = dataApi): AccessStore {
  return {
    async locks(courseId) {
      if (!courseId) return [];
      return (await api.getLocks(courseId))?.locks ?? [];
    },
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

/** SCORM run-time state through GET and PUT /api/scorm; the learner is the session, so `learnerId` only gates the call. */
export function readerApiScormRecords(api: DataApi = dataApi): ScormRecords {
  return {
    async load(courseId, learnerId, loId) {
      if (!courseId || !learnerId || !loId) return {};
      return (await api.getScorm(courseId, loId))?.cmi ?? {};
    },
    async save(record) {
      const { learnerId, ...attempt } = record;
      if (!attempt.courseId || !learnerId || !attempt.loId) return;
      const response = await api.saveScorm(attempt);
      if (failed(response)) log.error("Saving the SCORM record failed", { status: response!.status });
    }
  };
}

/**
 * Playground hand-ins through /api/playground. The server decides from the session whose snapshots
 * the caller may see or change (Rule 0475); "not available" (signed out, no database) answers nothing.
 */
export function readerApiPlaygroundSnapshots(api: DataApi = dataApi): PlaygroundSnapshots {
  return {
    async available(courseId) {
      return !!courseId && (await api.getPlayground(courseId)) !== null;
    },
    async reviews(courseId) {
      return !!courseId && ((await api.getPlayground(courseId))?.reviews ?? false);
    },
    async save(snapshot) {
      if (!snapshot.courseId || !snapshot.loId) return false;
      const { studentId: _studentId, studentName: _studentName, ...work } = snapshot;
      return (await api.savePlayground(work))?.ok ?? false;
    },
    async get(courseId, loId, studentId) {
      if (!courseId || !loId || !studentId) return null;
      return (await api.getPlayground(courseId, loId, studentId))?.snapshots[0] ?? null;
    },
    async list(courseId, loId) {
      if (!courseId || !loId) return [];
      return (await api.getPlayground(courseId, loId))?.snapshots ?? [];
    },
    async remove(courseId, loId) {
      if (!courseId || !loId) return;
      await api.removePlayground({ courseId, loId });
    }
  };
}

/** The stored presence roster through GET /api/presence/roster, for the realtime adapter's `roster` option; null when the read failed. */
export function readerApiPresenceRoster(api: DataApi = dataApi): (courseId: string | undefined, sinceIso: string) => Promise<StoredPresence[] | null> {
  return async (courseId, sinceIso) => (await api.getRoster(courseId, sinceIso))?.rows ?? null;
}

/** A Tutors Live tab's watcher report through POST /api/live/watch, for the realtime adapter's `watch` option. */
export function readerApiLiveWatch(api: DataApi = dataApi): (topic: string, watcher: string) => Promise<"normal" | "slow" | "paused" | null> {
  return async (topic, watcher) => (await api.watchLive({ topic, watcher }))?.tier ?? null;
}
