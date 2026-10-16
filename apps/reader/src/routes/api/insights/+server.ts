import type { RequestHandler } from "./$types";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { admits } from "#lib/server/feedback.ts";
import { INSIGHTS_REFUSALS, insights, parseInsightsAsk } from "#lib/server/insights.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";

/**
 * GET /api/insights?courseId=&span=&day=[&learnerId=]: a course's steps ranked by the help they
 * needed, its help response times and its cohort over the day, week or month ending with `day`
 * (Rules 0412, 0413, 0415), or one student's requests, hints, annotations and reflections (Rule
 * 0414); for an educator of the course only, in a course that admits them (Rule 0567). Tutors Time
 * asks from its own origin, which PRIVATE_API_ALLOWED_ORIGINS lists, with the session. Answers
 * `{ period, insights }` or `{ period, progress }`, or `{ message, reason }`; `not-ready` when the
 * database has no insights views yet (Rule 0416). Nothing is written.
 */
export const GET: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return answer(403, { message: "This origin may not read insights" }, {});
  if (adapters().anonymous || !locals.actor) return answer(401, { message: "Sign in with GitHub to read insights", reason: "signed-out" }, cors);
  const ask = parseInsightsAsk(url.searchParams);
  if (typeof ask === "string") return answer(400, { message: ask, reason: "invalid" }, cors);
  const read = insights(fetch);
  if (!read) return answer(503, { message: "Insights are not kept on this server", reason: "not-kept" }, cors);
  const login = locals.actor.login;
  const admitted = await admits(ask.courseId, login, fetch);
  if (admitted === null) return answer(503, { message: "The course could not be read; try again", reason: "unavailable" }, cors);
  if (!admitted) return answer(403, { message: "This course does not admit you", reason: "forbidden" }, cors);
  const result = ask.learnerId
    ? await read.student(login, ask.courseId, ask.learnerId, ask.span, ask.day)
    : await read.course(login, ask.courseId, ask.span, ask.day);
  if (!result.ok) {
    const refusal = INSIGHTS_REFUSALS[result.reason] ?? INSIGHTS_REFUSALS.unavailable;
    if (result.reason === "not-ready") log.warn("Insights were asked for but the insights views are missing", { courseId: ask.courseId });
    return answer(refusal.status, { message: refusal.message, reason: result.reason }, cors);
  }
  return answer(200, ask.learnerId ? { period: result.period, progress: result.value } : { period: result.period, insights: result.value }, cors);
};

/** The preflight for Tutors Time's read, with the session. */
export const OPTIONS: RequestHandler = async ({ request, url }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }
  });
};
