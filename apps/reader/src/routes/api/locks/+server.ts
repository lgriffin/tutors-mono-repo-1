import { error, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { setContentLock } from "@tutors/application";
import { noContent, readJson, requireData, requireUser, valid } from "#lib/server/api/http.ts";
import { authorize } from "#lib/server/api/access.ts";
import * as check from "#lib/server/api/validate.ts";

/** Only an educator of the course may lock or unlock its content (Rule 0065). */
async function educatorRequest(request: Request, locals: RequestEvent["locals"]) {
  const user = await requireUser(locals);
  const body = await readJson(request);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const loRoute = valid(check.loRoute(body.loRoute), "loRoute is required");
  if (!(await authorize(user, "content:lock", { kind: "course", courseId }))) error(403, "Only an educator of this course can lock its content");
  return { user, body, courseId, loRoute };
}

export const PUT: RequestHandler = async ({ request, locals }) => {
  const { user, body, courseId, loRoute } = await educatorRequest(request, locals);
  if (typeof body.locked !== "boolean") error(400, "locked is true or false");
  const { accessStore } = requireData();
  if (!(await setContentLock({ store: accessStore })(courseId, loRoute, body.locked, user.login))) error(500, "The lock could not be saved");
  return noContent();
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const { courseId, loRoute } = await educatorRequest(request, locals);
  const { accessStore } = requireData();
  await accessStore.removeLock(courseId, loRoute);
  return noContent();
};
