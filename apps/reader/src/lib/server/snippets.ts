/**
 * The reader server's side of snippet sharing and lecturer broadcasts: the snippet store of the
 * composed data API (Supabase over the service-role key, as `course_gists` is closed to the anon
 * role, or Postgres, as DATA_STORE picks), the realtime publisher PUBLIC_REALTIME picks, and the
 * educator check that reads a course's published enrollment.
 */
import { courseAccessOf, educatorsFrom, isCourseEducator, createBroadcastLimiter, type EducatorCheck } from "@tutors/application";
import type { CourseNotices, SnippetStore } from "@tutors/application/ports";
import { httpCourseSource } from "@tutors/course-http";
import { readerServer } from "./api/adapters.ts";

/** The store the share route writes to; null when the deployment has no store (no service key, or on Postgres no database URL). */
export function serviceSnippetStore(): SnippetStore | null {
  return readerServer().data?.snippets ?? null;
}

/** Posting publishes at once, over Supabase's service client or to Valkey (neither configured: nothing is published); the server watches nothing. */
export const serverNotices: CourseNotices = {
  post: (notice) => readerServer().realtime.notice(notice),
  watch: () => () => {}
};

/** One limiter for the server's lifetime: one broadcast per course per minute, whoever sends it. */
export const broadcastLimiter = createBroadcastLimiter();

/** A course's access rules (auth level and enrollment) from its published tutors.json, cached for five minutes. */
export const accessOf = courseAccessOf({ source: httpCourseSource() });

/** A course's educator logins from its published enrollment, from the same cache; shared by every route that checks one. */
export const educatorsOf = educatorsFrom(accessOf);
const check = isCourseEducator(educatorsOf);

/** Whether the request's actor teaches the course, read from the course's published enrollment. */
export function requireEducator(login: string | null | undefined, courseId: string, fetchFn: typeof fetch): Promise<EducatorCheck> {
  return check(courseId, login, (url) => fetchFn(url));
}
