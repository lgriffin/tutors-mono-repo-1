/**
 * The reader server's composition root for its data API (routes/api, guides/SERVER-WRITES.md):
 * the store adapter over the service_role client, which writes for the session the identity
 * handle verified, and the authorization module over the published courses. Read once from the
 * private environment by `lib/server/api/adapters.ts`; tests compose it with the environment they
 * want. Without a service key (or in anonymous mode) there is no data: the routes answer 503.
 */
import type { AccessStore, LearningEventSink, LearningRecords, ProfilePort, ScormRecords, WhiteboardStore } from "@tutors/application/ports";
import { createAuthorization, listFromEnv, type Authorization } from "@tutors/application";
import { clock } from "@tutors/clock";
import { httpCourseFacts } from "@tutors/course-http";
import {
  createSupabaseServiceClient,
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
  PRIVATE_COURSE_HOSTS?: string;
  PRIVATE_TUTORS_ADMINS?: string;
};

/** The ports the data API's routes call, all over the service client. */
export type ReaderServerData = {
  /** The service client itself, for the Tutors Live publishing the realtime adapter does on the server. */
  db: SupabaseClient;
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
  /** Playground hand-ins; the route decides whose (GET, PUT and DELETE /api/playground). */
  playground: PlaygroundSnapshotRows;
  /** The error log (POST /api/errors). */
  recordErrors(rows: AppErrorRow[]): Promise<void>;
  /** A Tutors Live tab watching a Realtime topic (POST /api/live/watch); the day's tier, or null. */
  watchLive(topic: string, watcher: string): Promise<LiveBudgetTier | null>;
};

export type ReaderServer = {
  authorization: Authorization;
  /** Null when the server has no service client: anonymous mode, or the key is missing or is the anon key. */
  data: ReaderServerData | null;
};

function isAnonymous(env: ReaderServerEnv): boolean {
  return env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
}

/** The service client, or null (logged once) when this server may not write. */
function serviceClient(env: ReaderServerEnv): SupabaseClient | null {
  const url = env.PUBLIC_SUPABASE_URL?.trim();
  const key = env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (isAnonymous(env)) return null;
  if (!url || !key) {
    log.warn("Server-side Supabase is not configured (PUBLIC_SUPABASE_URL / PRIVATE_SUPABASE_SERVICE_ROLE_KEY missing); /api routes answer 503");
    return null;
  }
  if (key === env.PUBLIC_SUPABASE_ANON_KEY?.trim()) {
    log.error("PRIVATE_SUPABASE_SERVICE_ROLE_KEY is the anon key; /api routes answer 503 until the service_role key is set");
    return null;
  }
  // Calls made while serving a request carry its x-request-id.
  return createSupabaseServiceClient(url, key, withRequestId()) ?? null;
}

export function composeReaderServer(env: ReaderServerEnv, options: { fetch?: typeof fetch } = {}): ReaderServer {
  const authorization = createAuthorization({
    courseFacts: httpCourseFacts({ fetch: options.fetch, allowedHosts: listFromEnv(env.PRIVATE_COURSE_HOSTS) }),
    clock,
    admins: listFromEnv(env.PRIVATE_TUTORS_ADMINS)
  });
  const db = serviceClient(env);
  if (!db) return { authorization, data: null };
  return {
    authorization,
    data: {
      db,
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
      playground: supabasePlaygroundSnapshotRows(db),
      recordErrors: (rows) => insertAppErrors(db, rows),
      watchLive: (topic, watcher) => watchLiveTopic(db, topic, watcher)
    }
  };
}
