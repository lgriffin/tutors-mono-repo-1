import { json, error, type RequestHandler } from "@sveltejs/kit";
import { noContent, readJson, requireData, requireUser, sessionUser, valid } from "#lib/server/api/http.ts";
import * as check from "#lib/server/api/validate.ts";

/** A whiteboard's stored scene: the shared board of a learning object, or the session's own copy (Rule 0068). */
export const GET: RequestHandler = async ({ url, locals }) => {
  const courseId = valid(check.courseId(url.searchParams.get("courseId")), "courseId is required");
  const route = valid(check.loRoute(url.searchParams.get("route")), "route is required");
  const shared = url.searchParams.get("shared") === "true";
  let owner: string | null = null;
  if (!shared) {
    const user = await sessionUser(locals);
    if (!user) error(401, "Sign in to open your personal whiteboard");
    owner = user.login;
  }
  const scene = await requireData().whiteboard.load({ courseId, route, shared }, owner);
  return json({ scene });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request, 512 * 1024);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const route = valid(check.loRoute(body.route), "route is required");
  if (!Array.isArray(body.elements)) error(400, "elements is a list");
  const shared = body.shared === true;
  await requireData().whiteboard.save({ courseId, route, shared }, user.login, body.elements);
  return noContent();
};
