/**
 * The time app's side of snippet sharing, composed from private environment the way Moodle is:
 * the Postgres store over PRIVATE_DATABASE_URL behind the educator check that gates it. The check
 * reads the course's published tutors.json for its `enrollment.educators`, so there is one
 * source of truth and nothing to sync at publish time. It fails closed: a course with no
 * enrollment has no educators and admits nobody.
 *
 * Do not use the course PIN for this: it is delivered to the browser and compared client-side,
 * so it identifies nobody.
 */
import * as env from "$app/env/private";
import type { RequestEvent } from "@sveltejs/kit";
import { courseEducators, isCourseEducator, type EducatorCheck } from "@tutors/application";
import type { SnippetStore } from "@tutors/application/ports";
import { checkPostgres, postgresClient, postgresSnippetStore, recentErrorCounts, type SqlClient } from "@tutors/store-postgres";
import { httpCourseSource } from "@tutors/course-http";

let pool: { url: string; sql: SqlClient } | undefined;

/** The Postgres pool when PRIVATE_DATABASE_URL is set: one per URL for the server's lifetime (the Moodle sync writes through it too). */
export function postgres(): SqlClient | undefined {
  const url = env.PRIVATE_DATABASE_URL?.trim();
  if (!url) return undefined;
  if (!pool || pool.url !== url) pool = { url, sql: postgresClient(url) };
  return pool.sql;
}

/** The store the dashboard reads from, or null when the deployment has no store. */
export function serviceSnippetStore(): SnippetStore | null {
  const sql = postgres();
  return sql ? postgresSnippetStore(sql) : null;
}

/** The store's name, its health check and the last hour's error counts, for GET /healthz. */
export function storeHealth() {
  const sql = postgres();
  return { store: "postgres", check: () => checkPostgres(sql), errorCounts: () => recentErrorCounts(sql) };
}

const educatorsOf = courseEducators({ source: httpCourseSource() });
const check = isCourseEducator(educatorsOf);

/** Authorise the request's actor as an educator of `courseId`. */
export function requireEducator(event: Pick<RequestEvent, "locals" | "fetch">, courseId: string): Promise<EducatorCheck> {
  return check(courseId, event.locals.actor?.login, (url) => event.fetch(url));
}
