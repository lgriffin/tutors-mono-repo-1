/**
 * The plain Postgres store adapter: every table the Tutors servers read and write, behind the same
 * ports as store-supabase (LearningEventSink, LearningRecords, ProfilePort, AccessStore,
 * WhiteboardStore, SnippetStore, ScormRecords, the playground's snapshot rows) plus the catalogue,
 * the presence roster, the error log and the health check. A server composes it when
 * DATA_STORE=postgres, over PRIVATE_DATABASE_URL. The schema is the plain SQL of db/migrations,
 * applied by `migrate` (`pnpm db:migrate`); `pg` is imported here, lazily, and in live-postgres.
 */
export { postgresClient, StoreError, type SqlClient } from "./client.ts";
export { migrate, type Migration, type MigrationRun } from "./migrate.ts";
export { postgresLearningEventSink } from "./learning-events.ts";
export { postgresLearningRecords } from "./learning-records.ts";
export { postgresProfile, upsertUser } from "./profile.ts";
export { postgresAccessStore } from "./access-store.ts";
export { postgresWhiteboardStore } from "./whiteboard-scenes.ts";
export { postgresScormRecords } from "./scorm-records.ts";
export { postgresPlaygroundSnapshotRows } from "./playground-snapshots.ts";
export { postgresSnippetStore } from "./snippets.ts";
export { postgresCatalogue, recordCourseVisit } from "./catalogue.ts";
export { upsertLatest, readRoster } from "./presence-rows.ts";
export { insertAppErrors, recentErrorCounts } from "./app-errors.ts";
export { checkPostgres } from "./health-check.ts";
