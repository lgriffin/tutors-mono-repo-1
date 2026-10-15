import { error, type RequestHandler } from "@sveltejs/kit";
import { noContent, readJson, requireData, requireUser, valid } from "#lib/server/api/http.ts";
import * as check from "#lib/server/api/validate.ts";

/** A page load or a 30-second tick, recorded through the LearningEventSink for the session's login (Rules 0071, 0072). */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const day = valid(check.calendarDay(body.day, new Date()), "day must be the browser's local date, yyyy-mm-dd");
  const { learningEvents } = requireData();
  if (body.kind === "page-load") {
    const loId = valid(check.loRoute(body.loId), "loId is required");
    const loType = valid(check.loType(body.loType), "loType is required");
    await learningEvents.record({ kind: "page-load", courseId, loId, loType, day }, user.login);
  } else if (body.kind === "tick") {
    const loId = body.loId === undefined || body.loId === null ? null : valid(check.loRoute(body.loId), "loId is malformed");
    await learningEvents.record({ kind: "tick", courseId, loId, day }, user.login);
  } else {
    error(400, 'kind is "page-load" or "tick"');
  }
  return noContent();
};
