/**
 * The Supabase store adapter: every table Tutors reads and writes, behind the application's
 * ports (LearningEventSink, LearningRecords, ProfilePort, AccessStore, WhiteboardStore, SnippetStore,
 * ScormRecords, PlaygroundSnapshots) plus the catalogue, the error transport and the health check
 * the apps use directly. The browser composes it with the anon key, which may only read; the
 * reader's server composes it with the service key and writes for the session it verified
 * (guides/SERVER-WRITES.md). @supabase/supabase-js is imported here and in the realtime adapter,
 * nowhere else.
 */
export {
  supabase,
  createSupabaseClient,
  createSupabaseServiceClient,
  configureSupabase,
  supabaseConfig,
  StoreError,
  type SupabaseConfig,
  type SupabaseClient
} from "./client.ts";
export * from "./learning-events.ts";
export * from "./learning-records.ts";
export * from "./time-rows.ts";
export * from "./presence-rows.ts";
export * from "./profile.ts";
export * from "./access-store.ts";
export * from "./scorm-records.ts";
export * from "./playground-snapshots.ts";
export * from "./snippets.ts";
export * from "./catalogue.ts";
export * from "./course-catalogue.ts";
export * from "./whiteboard-scenes.ts";
export { createSupabaseErrorTransport } from "./error-transport.ts";
export { checkSupabase, getRecentErrorCounts } from "./health-check.ts";
