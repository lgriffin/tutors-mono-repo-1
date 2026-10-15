import { json, error, type RequestHandler } from "@sveltejs/kit";
import type { CourseVisit } from "@tutors/domain/presence";
import { noContent, readJson, requireData, requireUser } from "#lib/server/api/http.ts";

const MAX_VISITS = 1000;

/** The signed-in user's course-visit history, through the ProfilePort for the session's login. */
export const GET: RequestHandler = async ({ locals }) => {
  const user = await requireUser(locals);
  return json({ courseVisits: await requireData().profile.getCourseVisits(user.login) });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request, 512 * 1024);
  const visits = body.courseVisits;
  if (!Array.isArray(visits) || visits.length > MAX_VISITS || !visits.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    error(400, `courseVisits is a list of at most ${MAX_VISITS} course visits`);
  }
  await requireData().profile.saveCourseVisits(user.login, visits as CourseVisit[]);
  return noContent();
};
