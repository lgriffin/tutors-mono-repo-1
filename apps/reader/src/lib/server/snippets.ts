/**
 * The reader server's side of snippet sharing and lecturer broadcasts, composed from private
 * environment the way the time app composes Moodle: the Supabase store bound to the service-role
 * key (the `course_gists` table is closed to the anon role), the realtime publisher over the
 * service client, and the educator check that reads a course's published enrollment.
 */
import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { courseEducators, isCourseEducator, createBroadcastLimiter, type EducatorCheck } from "@tutors/application";
import type { CourseNotices, SnippetStore } from "@tutors/application/ports";
import { createSupabaseClient, supabaseSnippetStore } from "@tutors/store-supabase";
import { publishCourseNotice } from "@tutors/realtime-supabase";
import { httpCourseSource } from "@tutors/course-http";
import { readerServer } from "./api/adapters.ts";

/** The store the share route writes to; null when the deployment has no service key. */
export function serviceSnippetStore(): SnippetStore | null {
  const client = createSupabaseClient(publicEnv.PUBLIC_SUPABASE_URL, env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY);
  return client ? supabaseSnippetStore(client) : null;
}

/** Posting publishes over the server's service client at once (none: nothing is published); the server watches nothing. */
export const serverNotices: CourseNotices = {
  post: (notice) => publishCourseNotice(readerServer().data?.db, notice),
  watch: () => () => {}
};

/** One limiter for the server's lifetime: one broadcast per course per minute, whoever sends it. */
export const broadcastLimiter = createBroadcastLimiter();

const educatorsOf = courseEducators({ source: httpCourseSource() });
const check = isCourseEducator(educatorsOf);

/** Whether the request's actor teaches the course, read from the course's published enrollment. */
export function requireEducator(login: string | null | undefined, courseId: string, fetchFn: typeof fetch): Promise<EducatorCheck> {
  return check(courseId, login, (url) => fetchFn(url));
}
