/**
 * The data API: every route Tutors' browser code may call for data it does not read in public, with
 * what each one takes and returns. Browser packages talk to personal data only through this contract
 * (the client in client.ts, behind the application ports in adapters.ts); the server side implements
 * it, today in the reader (apps/reader/src/routes/api, guides/SERVER-WRITES.md). The database behind
 * it can change without any browser package noticing: this layer is the seam.
 *
 * Every route identifies the caller from the session; nothing here carries a student id, except a
 * snapshot an educator asks for by its owner. The public reads (catalogue, presence roster, locks) and
 * the error and watcher reports answer other origins too, so the catalogue, live and time apps call
 * the reader at their PUBLIC_READER_URL (Rule 0471).
 */
import type { QueueEntry } from "@tutors/application";
import type { PlaygroundSnapshot, ScormRecord, WhiteboardRoom, WhiteboardScene } from "@tutors/application/ports";
import type { HelpKind, HelpRequest } from "@tutors/domain/assistance";
import type { ContentLock } from "@tutors/domain/access";
import type { CourseVisit } from "@tutors/domain/presence";

export type { ContentLock, PlaygroundSnapshot, WhiteboardRoom, WhiteboardScene };

/** POST /api/analytics: a page load, or the 30-second "still reading" tick, for the signed-in student. */
export type AnalyticsEvent =
  | { kind: "page-load"; courseId: string; loId: string; loType: string; day: string }
  | { kind: "tick"; courseId: string; loId: string | null; day: string };

/** GET /api/me: the signed-in user's stored sentiment and online status. */
export interface MyStatus {
  sentiment: string | null;
  online_status: string | null;
}

/** PUT /api/me (on sign-in) and PATCH /api/me: what the user may set about themselves. */
export interface MyStatusChange {
  sentiment?: string;
  onlineStatus?: "online" | "offline";
}

/** GET and PUT /api/profile: the signed-in user's course-visit history. */
export interface Profile<Visit = Record<string, unknown>> {
  courseVisits: Visit[];
}

/** POST /api/courses/visit: a visit to a published course, for the public catalogue. */
export interface CourseVisitReport {
  courseId: string;
  courseRecord: Record<string, unknown>;
}

/** POST /api/presence: the learning object a student who shares presence is on. */
export interface PresenceReport {
  courseId: string;
  payload: object;
}

/** PUT /api/locks (educators only). */
export interface LockChange {
  courseId: string;
  loRoute: string;
  locked: boolean;
}

/** DELETE /api/locks (educators only). */
export interface LockRemoval {
  courseId: string;
  loRoute: string;
}

/** PUT /api/whiteboard. */
export interface WhiteboardSave extends WhiteboardRoom {
  elements: unknown[];
}

/** One course card in the public catalogue (GET /api/catalogue). */
export interface CatalogueEntry {
  course_id: string;
  visited_at: string;
  visit_count: number;
  /** The card the reader stored from the published course (POST /api/courses/visit). */
  course_record: CourseVisit;
}

/** GET /api/catalogue: every visited course, most recent first, and how many students there are (a count, Rule 0070). */
export interface Catalogue {
  courses: CatalogueEntry[];
  studentCount: number;
}

/** One stored presence snapshot: a learner's latest learning object in a course, as they chose to share it. */
export interface RosterRow {
  course_id: string;
  student_id: string;
  payload: unknown;
  received_at: string;
}

/** GET /api/presence/roster?courseId=&since=: the stored snapshots, most recent first. */
export interface Roster {
  rows: RosterRow[];
}

/** GET /api/locks?courseId=: a course's content locks. */
export interface Locks {
  locks: ContentLock[];
}

/** GET /api/scorm?courseId=&loId=: the signed-in learner's saved CMI data model, empty for a first attempt. */
export interface ScormState {
  cmi: Record<string, string>;
}

/** PUT /api/scorm: the learner's attempt; the learner is the session. */
export type ScormSave = Omit<ScormRecord, "learnerId">;

/**
 * GET /api/playground?courseId=[&loId=[&studentId=]]: whether the session reviews the course's
 * hand-ins, and (with `loId`) the snapshots of that exercise it may see, newest first: its own for a
 * student, every one for an educator of the course (Rule 0475).
 */
export interface PlaygroundView {
  reviews: boolean;
  snapshots: PlaygroundSnapshot[];
}

/** PUT /api/playground: the session's own hand-in; the student id and name come from the session. */
export type PlaygroundSave = Omit<PlaygroundSnapshot, "updatedAt" | "studentId" | "studentName">;

/** DELETE /api/playground: withdraws the session's own hand-in. */
export interface PlaygroundRemoval {
  courseId: string;
  loId: string;
}

/** One warning or error a browser reports (POST /api/errors). */
export interface ErrorReportEntry {
  level: "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
  url?: string | null;
  courseId?: string | null;
}

/** POST /api/errors: a batch of at most 20 entries from one app, 16 KB at most. */
export interface ErrorReport {
  app: string;
  entries: ErrorReportEntry[];
}

/** POST /api/live/watch: a Tutors Live tab watching a Realtime topic. */
export interface LiveWatch {
  topic: string;
  watcher: string;
}

/** The answer to POST /api/live/watch: the day's Live budget tier, null when it could not be read. */
export interface LiveWatchTier {
  tier: "normal" | "slow" | "paused" | null;
}

/**
 * POST /api/assistance: a signed-in student asks for help on a step, or anyone acts on a request by
 * id: the student who asked withdraws or resolves it, an educator of the course acknowledges,
 * answers a hint or resolves it. Answers `{ request }` (201 for a new one), or `{ message, reason }`.
 */
export type HelpPost =
  | { action: "request"; courseId: string; labRoute: string; stepId: string; kind: HelpKind }
  | { action: "acknowledge" | "resolve" | "withdraw"; id: string }
  | { action: "answer-hint"; id: string; hintText: string };

/** GET /api/assistance/mine?courseId=: the student's own live request, from stored rows. */
export interface MyHelpRequest {
  request: HelpRequest | null;
}

/** GET /api/assistance?courseId=: the course's queue, for an educator of the course; Tutors Live calls it with the lecturer's session. */
export interface HelpQueue {
  queue: QueueEntry[];
}
