/**
 * The reader server's composition root for its data API (routes/api, guides/SERVER-WRITES.md):
 * the store adapter, which writes for the session the identity handle verified, and the
 * authorization module over the published courses. DATA_STORE picks the store: `supabase` (the
 * default) over the service_role client, or `postgres` over PRIVATE_DATABASE_URL (store-postgres,
 * Rule 0477). Read once from the private environment by `lib/server/api/adapters.ts`; tests compose
 * it with the environment they want. Without the store's credentials (or in anonymous mode) there
 * is no data: the routes answer 503.
 */
import type { AccessStore, LearningEventSink, LearningRecords, ProfilePort, ScormRecords, SnippetStore, WhiteboardStore } from "@tutors/application/ports";
import { createAuthorization, listFromEnv, type Authorization } from "@tutors/application";
import { clock } from "@tutors/clock";
import { httpCourseFacts } from "@tutors/course-http";
import {
  checkPostgres,
  insertAppErrors as insertPostgresAppErrors,
  postgresAccessStore,
  postgresCatalogue,
  postgresClient,
  postgresLearningEventSink,
  postgresLearningRecords,
  postgresPlaygroundSnapshotRows,
  postgresProfile,
  postgresScormRecords,
  postgresSnippetStore,
  postgresWhiteboardStore,
  readRoster as readPostgresRoster,
  recentErrorCounts,
  recordCourseVisit as recordPostgresCourseVisit,
  upsertLatest as upsertPostgresLatest,
  type SqlClient
} from "@tutors/store-postgres";
import {
  checkSupabase,
  createSupabaseServiceClient,
  getRecentErrorCounts,
  insertAppErrors,
  readRoster,
  recordCourseVisit,
  supabaseAccessStore,
  supabaseCatalogue,
  supabaseLearningEventSink,
  supabaseLearningRecords,
  supabasePlaygroundSnapshotRows,
  supabaseProfile,
  supabaseScormRecords,
  supabaseSnippetStore,
  supabaseWhiteboardStore,
  upsertLatest,
  type AppErrorRow,
  type CatalogueService,
  type PlaygroundSnapshotRows,
  type SupabaseClient
} from "@tutors/store-supabase";
import { watchLiveTopic, type LiveBudgetTier } from "@tutors/realtime-supabase";
import type { TutorsConnectLatestRow } from "@tutors/domain/learning";
import log, { withRequestId } from "@tutors/logger";

export type ReaderServerEnv = {
  PUBLIC_ANON_MODE?: string;
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_ANON_KEY?: string;
  PRIVATE_SUPABASE_SERVICE_ROLE_KEY?: string;
  /** `supabase` (the default) or `postgres`. */
  DATA_STORE?: string;
  /** The Postgres the store uses when DATA_STORE=postgres. */
  PRIVATE_DATABASE_URL?: string;
  PRIVATE_COURSE_HOSTS?: string;
  PRIVATE_TUTORS_ADMINS?: string;
};

/** One check of the store, for GET /healthz. */
type StoreCheck = { status: "ok" | "error" | "skipped"; latencyMs: number; message?: string };

/** The ports the data API's routes call, all over the store DATA_STORE picks. */
export type ReaderServerData = {
  /** Which store the ports are over. */
  store: "supabase" | "postgres";
  /** The Supabase service client, for the Tutors Live and notice publishing the realtime adapter does on the server; null when Supabase is not configured (S3 moves this to Valkey). */
  realtime: SupabaseClient | null;
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
  /** A Tutors Live tab watching a Realtime topic (POST /api/live/watch); the day's tier, or null. */
  watchLive(topic: string, watcher: string): Promise<LiveBudgetTier | null>;
};

export type ReaderServer = {
  authorization: Authorization;
  /** Null when the server has no store: anonymous mode, or the store's key or URL is missing (or the service key is the anon key). */
  data: ReaderServerData | null;
};

function isAnonymous(env: ReaderServerEnv): boolean {
  return env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
}

/** The service client, or null (logged once, when `required`) when this server may not write with it. */
function serviceClient(env: ReaderServerEnv, required = true): SupabaseClient | null {
  const url = env.PUBLIC_SUPABASE_URL?.trim();
  const key = env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (isAnonymous(env)) return null;
  if (!url || !key) {
    if (required) log.warn("Server-side Supabase is not configured (PUBLIC_SUPABASE_URL / PRIVATE_SUPABASE_SERVICE_ROLE_KEY missing); /api routes answer 503");
    return null;
  }
  if (key === env.PUBLIC_SUPABASE_ANON_KEY?.trim()) {
    log.error("PRIVATE_SUPABASE_SERVICE_ROLE_KEY is the anon key; /api routes answer 503 until the service_role key is set");
    return null;
  }
  // Calls made while serving a request carry its x-request-id.
  return createSupabaseServiceClient(url, key, withRequestId()) ?? null;
}

/** The store DATA_STORE names; anything but `postgres` is Supabase, so the dual release keeps Supabase until a deployment opts in. */
function dataStoreOf(env: { DATA_STORE?: string }): "supabase" | "postgres" {
  return env.DATA_STORE?.trim().toLowerCase() === "postgres" ? "postgres" : "supabase";
}

function supabaseData(db: SupabaseClient): ReaderServerData {
  return {
    store: "supabase",
    realtime: db,
    health: { check: () => checkSupabase(db), errorCounts: () => getRecentErrorCounts(db) },
    learningEvents: supabaseLearningEventSink(db),
    profile: supabaseProfile(db),
    records: supabaseLearningRecords(db),
    accessStore: supabaseAccessStore(db),
    whiteboard: supabaseWhiteboardStore(db),
    storePresence: (login, courseId, payload) => upsertLatest(db, login, courseId, payload, clock.now()),
    recordCourseVisit: (courseId, record) => recordCourseVisit(db, courseId, record, clock.now()),
    catalogue: supabaseCatalogue(db),
    roster: (courseId, sinceIso) => readRoster(db, courseId, sinceIso),
    scorm: supabaseScormRecords(db),
    snippets: supabaseSnippetStore(db),
    playground: supabasePlaygroundSnapshotRows(db),
    recordErrors: (rows) => insertAppErrors(db, rows),
    watchLive: (topic, watcher) => watchLiveTopic(db, topic, watcher)
  };
}

function postgresData(sql: SqlClient, realtime: SupabaseClient | null): ReaderServerData {
  return {
    store: "postgres",
    realtime,
    health: { check: () => checkPostgres(sql), errorCounts: () => recentErrorCounts(sql) },
    learningEvents: postgresLearningEventSink(sql),
    profile: postgresProfile(sql),
    records: postgresLearningRecords(sql),
    accessStore: postgresAccessStore(sql),
    whiteboard: postgresWhiteboardStore(sql),
    storePresence: (login, courseId, payload) => upsertPostgresLatest(sql, login, courseId, payload, clock.now()),
    recordCourseVisit: (courseId, record) => recordPostgresCourseVisit(sql, courseId, record, clock.now()),
    catalogue: postgresCatalogue(sql),
    roster: (courseId, sinceIso) => readPostgresRoster(sql, courseId, sinceIso),
    scorm: postgresScormRecords(sql),
    snippets: postgresSnippetStore(sql),
    playground: postgresPlaygroundSnapshotRows(sql),
    recordErrors: (rows) => insertPostgresAppErrors(sql, rows),
    // The Realtime budget is Supabase's until S3 replaces it: without a service client there is no tier to report.
    watchLive: (topic, watcher) => (realtime ? watchLiveTopic(realtime, topic, watcher) : Promise.resolve(null))
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
  if (dataStoreOf(env) === "postgres") {
    if (isAnonymous(env)) return { authorization, data: null };
    const url = env.PRIVATE_DATABASE_URL?.trim();
    if (!url && !options.sql) {
      log.warn("DATA_STORE=postgres but PRIVATE_DATABASE_URL is missing; /api routes answer 503");
      return { authorization, data: null };
    }
    return { authorization, data: postgresData(options.sql ?? postgresClient(url!), serviceClient(env, false)) };
  }
  const db = serviceClient(env);
  return { authorization, data: db ? supabaseData(db) : null };
}
