/**
 * The reader server's composition root for its data API (routes/api, guides/SERVER-WRITES.md):
 * the Postgres store over PRIVATE_DATABASE_URL (store-postgres, schema in db/migrations), which
 * writes for the session the identity handle verified, and the authorization module over the
 * published courses. Read once from the private environment by `lib/server/api/adapters.ts`; tests
 * compose it with the environment they want. Without the database URL (or in anonymous mode) there
 * is no data: the routes answer 503. The server publishes to Tutors Live, course notices and the
 * help queue over Valkey pub/sub at PRIVATE_VALKEY_URL (one process's memory without it), which the
 * realtime stream routes fan out over server-sent events (realtime-valkey).
 */
import type {
  AccessStore,
  AssistanceFeed,
  AssistanceStore,
  FeedbackStore,
  InsightsRead,
  LearningEventSink,
  LearningRecords,
  ProfilePort,
  ScormRecords,
  SnippetStore,
  WhiteboardStore
} from "@tutors/application/ports";
import { createAuthorization, listFromEnv, type Authorization } from "@tutors/application";
import { clock } from "@tutors/clock";
import { httpCourseFacts } from "@tutors/course-http";
import {
  checkPostgres,
  insertAppErrors,
  postgresAccessStore,
  postgresAssistanceStore,
  postgresCatalogue,
  postgresClient,
  postgresFeedbackStore,
  postgresInsightsRead,
  postgresLearningEventSink,
  postgresLearningRecords,
  postgresPlaygroundSnapshotRows,
  postgresProfile,
  postgresScormRecords,
  postgresSnippetStore,
  postgresWhiteboardStore,
  readRoster,
  recentErrorCounts,
  recordCourseVisit,
  upsertLatest,
  type AppErrorRow,
  type CatalogueService,
  type PlaygroundSnapshotRows,
  type SqlClient
} from "@tutors/store-postgres";
import { publishLiveActivity, publishNotice, realtimeHub, valkeyAssistanceFeed, type RealtimeHub, type ValkeyActivityResponse } from "@tutors/realtime-valkey";
import type { CourseNotice } from "@tutors/application/ports";
import type { TutorsConnectLatestRow } from "@tutors/domain/learning";
import log from "@tutors/logger";

export type ReaderServerEnv = {
  PUBLIC_ANON_MODE?: string;
  /** The Postgres the store uses. */
  PRIVATE_DATABASE_URL?: string;
  PRIVATE_COURSE_HOSTS?: string;
  PRIVATE_TUTORS_ADMINS?: string;
  /** The Valkey the server publishes to; unset, one process's memory. */
  PRIVATE_VALKEY_URL?: string;
};

/** One check of the store, for GET /healthz. */
type StoreCheck = { status: "ok" | "error" | "skipped"; latencyMs: number; message?: string };

/** The ports the data API's routes call, all over the Postgres store. */
export type ReaderServerData = {
  /** The store's health check and the last hour's error counts. */
  health: { check(): Promise<StoreCheck>; errorCounts(): Promise<{ app: string; level: string; count: number }[]> };
  learningEvents: LearningEventSink;
  profile: ProfilePort;
  records: LearningRecords;
  accessStore: AccessStore;
  whiteboard: WhiteboardStore;
  /** The latest snapshot of `login` in a course, for Tutors Live. */
  storePresence(login: string, courseId: string, payload: unknown): Promise<void>;
  /** A visit to a published course, for the catalogue. */
  recordCourseVisit(courseId: string, record: Record<string, unknown>): Promise<void>;
  /** The public catalogue and the student count (GET /api/catalogue). */
  catalogue: CatalogueService;
  /** The stored presence snapshots (GET /api/presence/roster); null when the read failed. */
  roster(courseId: string | null, sinceIso: string | null): Promise<TutorsConnectLatestRow[] | null>;
  /** SCORM run-time state, for the session's login (GET and PUT /api/scorm). */
  scorm: ScormRecords;
  /** Shared snippets (POST /api/gists); the route checks who may share. */
  snippets: SnippetStore;
  /** Playground hand-ins; the route decides whose (GET, PUT and DELETE /api/playground). */
  playground: PlaygroundSnapshotRows;
  /** The error log (POST /api/errors). */
  recordErrors(rows: AppErrorRow[]): Promise<void>;
  /** Help requests (/api/assistance). */
  assistance: AssistanceStore;
  /** Lecturer feedback and shared reflections (/api/feedback). */
  feedback: FeedbackStore;
  /** The read-only views insights are computed from (GET /api/insights). */
  insights: InsightsRead;
};

/** What the server publishes to browsers, over Valkey. */
type ServerRealtime = {
  /** A learning event a reader posted (POST /api/live/activity), published to Tutors Live. */
  activity(raw: string): Promise<ValkeyActivityResponse>;
  /** A course notice (a snippet ping, a lecturer's broadcast); false when it was not published. */
  notice(notice: CourseNotice): Promise<boolean>;
  /** The hub the realtime stream and publish routes use, or null in anonymous mode. */
  hub: RealtimeHub | null;
  /** Help queue changes for the course's educators (Rule 0391). */
  assistance: AssistanceFeed;
};

export type ReaderServer = {
  authorization: Authorization;
  /** Null when the server has no store: anonymous mode, or PRIVATE_DATABASE_URL is missing. */
  data: ReaderServerData | null;
  realtime: ServerRealtime;
};

function isAnonymous(env: ReaderServerEnv): boolean {
  return env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
}

function postgresData(sql: SqlClient): ReaderServerData {
  return {
    health: { check: () => checkPostgres(sql), errorCounts: () => recentErrorCounts(sql) },
    learningEvents: postgresLearningEventSink(sql),
    profile: postgresProfile(sql),
    records: postgresLearningRecords(sql),
    accessStore: postgresAccessStore(sql),
    whiteboard: postgresWhiteboardStore(sql),
    storePresence: (login, courseId, payload) => upsertLatest(sql, login, courseId, payload, clock.now()),
    recordCourseVisit: (courseId, record) => recordCourseVisit(sql, courseId, record, clock.now()),
    catalogue: postgresCatalogue(sql),
    roster: (courseId, sinceIso) => readRoster(sql, courseId, sinceIso),
    scorm: postgresScormRecords(sql),
    snippets: postgresSnippetStore(sql),
    playground: postgresPlaygroundSnapshotRows(sql),
    recordErrors: (rows) => insertAppErrors(sql, rows),
    assistance: postgresAssistanceStore(sql),
    feedback: postgresFeedbackStore(sql),
    insights: postgresInsightsRead(sql)
  };
}

/** Valkey pub/sub (Rule 0481): no budget, no database call; the hub is null in anonymous mode, so nothing is published. */
function valkeyRealtime(env: ReaderServerEnv): ServerRealtime {
  const hub = isAnonymous(env) ? null : realtimeHub(env.PRIVATE_VALKEY_URL);
  if (hub?.kind === "memory") log.warn("PRIVATE_VALKEY_URL is missing; realtime reaches this server's own streams only");
  return {
    activity: (raw) => publishLiveActivity(raw, hub),
    notice: (notice) => publishNotice(hub, notice),
    hub,
    assistance: valkeyAssistanceFeed(hub)
  };
}

/**
 * `options.sql` stands in for the pool PRIVATE_DATABASE_URL would open, so a test can hand the
 * Postgres store any database (PGlite, or a schema of its own on a test server).
 */
export function composeReaderServer(env: ReaderServerEnv, options: { fetch?: typeof fetch; sql?: SqlClient } = {}): ReaderServer {
  const authorization = createAuthorization({
    courseFacts: httpCourseFacts({ fetch: options.fetch, allowedHosts: listFromEnv(env.PRIVATE_COURSE_HOSTS) }),
    clock,
    admins: listFromEnv(env.PRIVATE_TUTORS_ADMINS)
  });
  const realtime = valkeyRealtime(env);
  if (isAnonymous(env)) return { authorization, data: null, realtime };
  const url = env.PRIVATE_DATABASE_URL?.trim();
  if (!url && !options.sql) {
    log.warn("PRIVATE_DATABASE_URL is missing; /api routes answer 503");
    return { authorization, data: null, realtime };
  }
  return { authorization, data: postgresData(options.sql ?? postgresClient(url!)), realtime };
}
