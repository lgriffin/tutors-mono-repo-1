/**
 * The time app's side of snippet sharing, composed from private environment the way Moodle is:
 * the Supabase store bound to the service-role key (`course_gists` is closed to the anon role,
 * so this key is the only way to read it) behind the educator check that gates it. The check
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
import { createSupabaseClient, supabaseSnippetStore } from "@tutors/store-supabase";
import { httpCourseSource } from "@tutors/course-http";

/** The store the dashboard reads from, or null when the deployment has no service key. */
export function serviceSnippetStore(): SnippetStore | null {
  const client = createSupabaseClient(publicEnv.PUBLIC_SUPABASE_URL, env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY);
  return client ? supabaseSnippetStore(client) : null;
}

const educatorsOf = courseEducators({ source: httpCourseSource() });
const check = isCourseEducator(educatorsOf);

/** Authorise the request's actor as an educator of `courseId`. */
export function requireEducator(event: Pick<RequestEvent, "locals" | "fetch">, courseId: string): Promise<EducatorCheck> {
  return check(courseId, event.locals.actor?.login, (url) => event.fetch(url));
}
