import type { RequestHandler } from "@sveltejs/kit";
import { AuthorizationUnavailableError, loadTimeRows } from "@tutors/application";
import log from "@tutors/logger";
import { sessionUser } from "#lib/server/api/http.ts";
import { authorization } from "#lib/server/api/access.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";
import { readerServer } from "#lib/server/api/adapters.ts";
import * as check from "#lib/server/api/validate.ts";

const corsHeaders = (request: Request, url: URL) => allowedOriginHeaders(request, url, true);

/**
 * A course's time data for Tutors Time, read with the viewer's reader session: in full for an
 * educator, pseudonymised for anyone else (Rules 0066, 0067, 0075). Cross-origin only from
 * PRIVATE_API_ALLOWED_ORIGINS.
 */
export const GET: RequestHandler = async ({ request, url, params, locals }) => {
  const cors = corsHeaders(request, url);
  if (!cors) return answer(403, { message: "This origin may not read time data" }, {});
  const courseId = check.courseId(params.courseId);
  if (!courseId) return answer(400, { message: "courseId is malformed" }, cors);
  const user = await sessionUser(locals);
  if (!user) return answer(401, { message: "Sign in to the reader to see time data" }, cors);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if ([start, end].some((day) => day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) || (start && end && start > end)) {
    return answer(400, { message: "start and end must be an ordered yyyy-mm-dd range" }, cors);
  }
  const { data } = readerServer();
  if (!data) return answer(503, { message: "Time data is not configured on this server" }, cors);

  let educator: boolean;
  try {
    educator = await authorization().can(user, "analytics:view", { kind: "course", courseId });
  } catch (e) {
    // Not knowing who teaches the course is not the same as "not an educator" (Rule 0073).
    if (e instanceof AuthorizationUnavailableError) return answer(503, { message: "Could not read who teaches this course from its host; try again shortly" }, cors);
    throw e;
  }
  const rows = await loadTimeRows({ records: data.records })({ login: user.login, educator }, courseId, start, end);
  log.info("Time data read", { courseId, role: rows.role });
  return answer(200, rows, cors);
};

export const OPTIONS: RequestHandler = async ({ request, url }) => {
  const cors = corsHeaders(request, url);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "600" } });
};
