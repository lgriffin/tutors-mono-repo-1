import type { RequestHandler } from "./$types";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { isEducatorOf } from "@tutors/domain/access";
import type { HelpKind } from "@tutors/domain/assistance";
import { HELP_REFUSALS, assistance, parseHelpPost } from "#lib/server/assistance.ts";
import { readJson } from "#lib/server/api/http.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";

/**
 * /api/assistance: help requests on lab steps. A signed-in student asks, asks again, withdraws or
 * marks one solved; an educator of the course acknowledges, answers a hint or resolves. Every
 * change is written here as the session's actor and then told to the course's educators over the
 * help queue's feed (Rules 0390, 0391). Tutors Live's course page reads the queue from another
 * origin, which PRIVATE_API_ALLOWED_ORIGINS lists, with the lecturer's session.
 */

const SIGN_IN = { message: "Sign in with GitHub to ask for help" };
const NOT_KEPT = { message: "Help requests are not kept on this server" };

/** GET /api/assistance?courseId=: the course's queue, from stored rows, for an educator of the course only (Rule 0392). */
export const GET: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return answer(403, { message: "This origin may not read the help queue" }, {});
  if (adapters().anonymous || !locals.actor) return answer(401, SIGN_IN, cors);
  const courseId = url.searchParams.get("courseId")?.trim() ?? "";
  if (!courseId) return answer(400, { message: "courseId is required" }, cors);
  const help = assistance(fetch);
  if (!help) return answer(503, NOT_KEPT, cors);
  if (!isEducatorOf(locals.actor.login, { educators: await help.educatorsOf(courseId) })) {
    return answer(403, { message: "Only an educator of the course may read its help queue" }, cors);
  }
  try {
    return answer(200, { queue: await help.queue(courseId) }, cors);
  } catch (error) {
    log.error("Reading the help queue failed:", courseId, error);
    return answer(503, { message: "The help queue could not be read" }, cors);
  }
};

/** POST /api/assistance: `{ action, ... }` as `parseHelpPost` reads it. */
export const POST: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return answer(403, { message: "This origin may not change help requests" }, {});
  if (adapters().anonymous || !locals.actor) return answer(401, SIGN_IN, cors);
  const post = parseHelpPost(await readJson(request, 8 * 1024));
  if (typeof post === "string") return answer(400, { message: post }, cors);
  const help = assistance(fetch);
  if (!help) return answer(503, NOT_KEPT, cors);
  const actor = locals.actor;
  const caller = { login: actor.login };
  const result =
    post.action === "request"
      ? await help.request(post.ref, post.kind as HelpKind, { login: actor.login, name: actor.name || null })
      : post.action === "acknowledge"
        ? await help.acknowledge(post.id, caller)
        : post.action === "answer-hint"
          ? await help.answerHint(post.id, caller, post.hintText)
          : post.action === "resolve"
            ? await help.resolve(post.id, caller)
            : await help.withdraw(post.id, caller);
  if (!result.ok) {
    const refusal = HELP_REFUSALS[result.reason];
    return answer(refusal.status, { message: refusal.message, reason: result.reason }, cors);
  }
  log.info("A help request changed", { action: post.action, courseId: result.request.ref.courseId, state: result.request.state });
  return answer(post.action === "request" ? 201 : 200, { request: result.request }, cors);
};

/** The preflight for a lecturer's change from Tutors Live, with the session. */
export const OPTIONS: RequestHandler = async ({ request, url }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }
  });
};
