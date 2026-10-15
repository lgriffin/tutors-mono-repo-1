/**
 * The Supabase store adapter: every table Tutors reads and writes, behind the application's
 * ports (LearningEventSink, LearningRecords, ProfilePort, AccessStore, WhiteboardStore, SnippetStore,
 * ScormRecords, the playground's snapshot rows) plus the catalogue, the error log and the health
 * check. Only the servers compose it, with the service key, and they read and write for the session
 * they verified (guides/SERVER-WRITES.md); browsers reach every table through the data API's routes
 * and use `createSupabaseClient` only for the Realtime gateway. @supabase/supabase-js is imported here
 * and in the realtime adapter, nowhere else.
 */
export { createSupabaseClient, createSupabaseServiceClient, StoreError, type SupabaseClient } from "./client.ts";
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
export * from "./app-errors.ts";
export { checkSupabase, getRecentErrorCounts } from "./health-check.ts";
