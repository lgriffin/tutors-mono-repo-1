/**
 * The application ports over the data API: what the browser compositions install for a deployment
 * with a database. Each one sends the request; the reader's server verifies the session and reads or
 * writes for its login (Rules 0071, 0072, 0473). Nothing here reads or writes a table.
 */
import { courseVisitOf, onlineStatusFor, parseSentiment, parseSharing, type CourseVisit, type PresenceEvent, type StoredPresence } from "@tutors/domain/presence";
import type { Course } from "@tutors/domain/course";
import type {
  AccessStore,
  FeedbackDesk,
  FeedbackDeskRefusal,
  FeedbackDeskResult,
  ReflectionDeskResult,
  HelpDesk,
  HelpDeskRefusal,
  HelpDeskResult,
  InsightsAnswer,
  InsightsDesk,
  InsightsPeriod,
  InsightsRefusal,
  LearningEventSink,
  PlaygroundSnapshots,
  ProfilePort,
  ScormRecords,
  WhiteboardStore
} from "@tutors/application/ports";
import type { HelpRequest } from "@tutors/domain/assistance";
import type { Annotation, Reflection } from "@tutors/domain/feedback";
import log from "@tutors/logger";
import { dataApi, type DataApi } from "./client.ts";
import type { CourseInsightsRead, StudentInsightsRead } from "./contract.ts";

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

const HELP_REFUSALS: readonly HelpDeskRefusal[] = ["invalid", "unavailable", "not-found", "conflict", "not-in-state-table", "not-permitted", "hint-required"];

/**
 * What the reader answered a help post with: the request it kept, or the refusal it named. 401 is
 * nobody signed in; a 503 naming no refusal is a server that keeps no help requests; a 400 naming
 * none is a post it could not read; anything else (no answer, an origin it does not list) is
 * "try again".
 */
async function helpAnswer(response: Response | null): Promise<HelpDeskResult> {
  if (!response) return { ok: false, reason: "unavailable" };
  const body = (await response.json().catch(() => null)) as { request?: HelpRequest; reason?: string } | null;
  if (response.ok && body?.request) return { ok: true, request: body.request };
  if (response.status === 401) return { ok: false, reason: "signed-out" };
  const named = HELP_REFUSALS.find((r) => r === body?.reason);
  if (named) return { ok: false, reason: named };
  if (response.status === 503) return { ok: false, reason: "not-kept" };
  return { ok: false, reason: response.status === 400 ? "invalid" : "unavailable" };
}

/**
 * Help requests through /api/assistance: the reader's server runs each ask as the session's actor
 * (Rule 0390). From Tutors Live's origin the calls carry the lecturer's session.
 */
export function readerApiHelpDesk(api: DataApi = dataApi): HelpDesk {
  return {
    ask: async (ref, kind) => helpAnswer(await api.postHelp({ action: "request", courseId: ref.courseId, labRoute: ref.labRoute, stepId: ref.stepId, kind })),
    act: async (id, action) => helpAnswer(await api.postHelp({ action, id })),
    answerHint: async (id, hintText) => helpAnswer(await api.postHelp({ action: "answer-hint", id, hintText })),
    rate: async (id, helped) => helpAnswer(await api.postHelp({ action: "rate", id, helped })),
    async mine(courseId) {
      const answer = await api.getMyHelpRequest(courseId);
      if (!answer) throw new Error("Your help request could not be read");
      return answer.request ?? null;
    },
    async queue(courseId) {
      const answer = await api.getHelpQueue(courseId);
      if (!answer) throw new Error("The help queue could not be read");
      return answer.queue.map((entry) => entry.request);
    }
  };
}

const FEEDBACK_REFUSALS: readonly FeedbackDeskRefusal[] = ["invalid", "forbidden", "not-found", "unavailable", "no-note"];

/** What the reader answered a feedback post with, read as a HelpDesk answer is: 401 signed out, a 503 naming nothing not kept, else the refusal it named. */
async function feedbackAnswer<T>(
  response: Response | null,
  pick: (body: Record<string, unknown>) => T | undefined
): Promise<{ ok: true; value: T } | { ok: false; reason: FeedbackDeskRefusal; detail?: string }> {
  if (!response) return { ok: false, reason: "unavailable" };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const value = body ? pick(body) : undefined;
  if (response.ok && value) return { ok: true, value };
  if (response.status === 401) return { ok: false, reason: "signed-out" };
  const named = FEEDBACK_REFUSALS.find((r) => r === body?.reason);
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  if (named) return detail ? { ok: false, reason: named, detail } : { ok: false, reason: named };
  if (response.status === 503) return { ok: false, reason: "not-kept" };
  return { ok: false, reason: response.status === 400 ? "invalid" : "unavailable" };
}

async function annotationAnswer(response: Response | null): Promise<FeedbackDeskResult> {
  const answer = await feedbackAnswer(response, (body) => body.annotation as Annotation | undefined);
  return answer.ok ? { ok: true, annotation: answer.value } : answer;
}

/**
 * Lecturer feedback through /api/feedback: the reader's server runs each ask as the session's
 * actor. From Tutors Live's and Tutors Time's origins the calls carry the lecturer's session.
 */
export function readerApiFeedbackDesk(api: DataApi = dataApi): FeedbackDesk {
  return {
    async step(ref) {
      const read = await api.getStepFeedback(ref.courseId, ref.labRoute, ref.stepId);
      if (!read) throw new Error("The step's feedback could not be read");
      return { broadcasts: read.broadcasts ?? [], personal: read.personal ?? [], history: read.history ?? null };
    },
    async received(courseId) {
      const read = await api.getMyFeedback(courseId);
      if (!read) throw new Error("Your feedback could not be read");
      return read.annotations ?? [];
    },
    annotate: async (anchor, audience, body) =>
      annotationAnswer(
        await api.postFeedback({
          action: "annotate",
          ...anchor.ref,
          snippetId: anchor.snippetId ?? null,
          reflectionId: anchor.reflectionId ?? null,
          learnerId: audience.learnerId ?? null,
          everyone: audience.everyone === true,
          body
        })
      ),
    broadcast: async (ref, body, stepTitle) => annotationAnswer(await api.postFeedback({ action: "broadcast", ...ref, body, stepTitle: stepTitle ?? null })),
    revoke: async (id) => annotationAnswer(await api.postFeedback({ action: "revoke", id })),
    async reflect(note): Promise<ReflectionDeskResult> {
      const answer = await feedbackAnswer(
        await api.postFeedback({ action: "reflect", ...note.ref, kind: note.kind, body: note.body }),
        (body) => body.reflection as Reflection | undefined
      );
      return answer.ok ? { ok: true, reflection: answer.value } : { ok: false, reason: answer.reason };
    }
  };
}

const INSIGHTS_REFUSALS: readonly InsightsRefusal[] = ["signed-out", "forbidden", "not-kept", "not-ready", "invalid", "unavailable"];

async function insightsAnswer<T>(response: Response | null, pick: (body: Record<string, unknown>) => T | undefined): Promise<InsightsAnswer<T>> {
  if (!response) return { ok: false, reason: "unavailable" };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const value = body ? pick(body) : undefined;
  if (response.ok && value && body?.period) return { ok: true, period: body.period as InsightsPeriod, value };
  if (response.status === 401) return { ok: false, reason: "signed-out" };
  const named = INSIGHTS_REFUSALS.find((r) => r === body?.reason);
  if (named) return { ok: false, reason: named };
  return { ok: false, reason: response.status === 400 ? "invalid" : "unavailable" };
}

/**
 * Insights through GET /api/insights: the reader's server runs the Insights use cases for the
 * session's educator; from Tutors Time's origin the call carries the lecturer's session.
 */
export function readerApiInsightsDesk(api: DataApi = dataApi): InsightsDesk {
  return {
    course: async (courseId, span, day) => insightsAnswer(await api.getInsights({ courseId, span, day }), (body) => body.insights as CourseInsightsRead["insights"] | undefined),
    student: async (courseId, learnerId, span, day) =>
      insightsAnswer(await api.getInsights({ courseId, span, day, learnerId }), (body) => body.progress as StudentInsightsRead["progress"] | undefined)
  };
}
