/**
 * The time app's side of snippet sharing, composed from private environment the way Moodle is:
 * the store DATA_STORE picks (Supabase bound to the service-role key, as `course_gists` is closed
 * to the anon role, or Postgres over PRIVATE_DATABASE_URL) behind the educator check that gates it. The check
 * reads the course's published tutors.json for its `enrollment.educators`, so there is one
 * source of truth and nothing to sync at publish time. It fails closed: a course with no
 * enrollment has no educators and admits nobody.
 *
 * Do not use the course PIN for this: it is delivered to the browser and compared client-side,
 * so it identifies nobody.
 */
import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import type { RequestEvent } from "@sveltejs/kit";
import { courseEducators, isCourseEducator, type EducatorCheck } from "@tutors/application";
import type { SnippetStore } from "@tutors/application/ports";
import { checkSupabase, createSupabaseServiceClient, getRecentErrorCounts, supabaseSnippetStore, type SupabaseClient } from "@tutors/store-supabase";
import { checkPostgres, postgresClient, postgresSnippetStore, recentErrorCounts, type SqlClient } from "@tutors/store-postgres";
import { httpCourseSource } from "@tutors/course-http";

/** The server's service client, or undefined when the deployment has no service key. */
function serviceClient(): SupabaseClient | undefined {
  return createSupabaseServiceClient(publicEnv.PUBLIC_SUPABASE_URL, env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY);
}

let pool: { url: string; sql: SqlClient } | undefined;

/** The Postgres pool when DATA_STORE=postgres and PRIVATE_DATABASE_URL is set: one per URL for the server's lifetime (the Moodle sync writes through it too). */
export function postgres(): SqlClient | undefined {
  if (env.DATA_STORE?.trim().toLowerCase() !== "postgres") return undefined;
  const url = env.PRIVATE_DATABASE_URL?.trim();
  if (!url) return undefined;
  if (!pool || pool.url !== url) pool = { url, sql: postgresClient(url) };
  return pool.sql;
}

export const usesPostgres = () => env.DATA_STORE?.trim().toLowerCase() === "postgres";

/** The store the dashboard reads from, or null when the deployment has no store. */
export function serviceSnippetStore(): SnippetStore | null {
  if (usesPostgres()) {
    const sql = postgres();
    return sql ? postgresSnippetStore(sql) : null;
  }
  const client = serviceClient();
  return client ? supabaseSnippetStore(client) : null;
}

/** The store's name, its health check and the last hour's error counts, for GET /healthz. */
export function storeHealth() {
  if (usesPostgres()) {
    const sql = postgres();
    return { store: "postgres", check: () => checkPostgres(sql), errorCounts: () => recentErrorCounts(sql) };
  }
  const db = serviceClient();
  return { store: "supabase", check: () => checkSupabase(db), errorCounts: () => getRecentErrorCounts(db) };
}

const educatorsOf = courseEducators({ source: httpCourseSource() });
const check = isCourseEducator(educatorsOf);

/** Authorise the request's actor as an educator of `courseId`. */
export function requireEducator(event: Pick<RequestEvent, "locals" | "fetch">, courseId: string): Promise<EducatorCheck> {
  return check(courseId, event.locals.actor?.login, (url) => event.fetch(url));
}
