import type { RequestHandler } from "./$types";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { isEducatorOf } from "@tutors/domain/access";
import { FEEDBACK_MESSAGES, feedback, parseFeedbackPost, parseStep } from "#lib/server/feedback.ts";
import { readJson } from "#lib/server/api/http.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";

/**
 * /api/feedback: lecturer feedback on lab steps. A signed-in student reads what was posted for them
 * at a step (Rule 0403) and shares a note as a reflection (Rule 0384); an educator of the course
 * also reads the step's history and reflections (Rule 0409), annotates a step, a snippet or a
 * reflection for one student, broadcasts an explanation to everyone on the step and revokes
 * (Rules 0400 to 0402, 0405, 0406). Every write runs here as the session's actor. Tutors Live and
 * Tutors Time post from other origins, which PRIVATE_API_ALLOWED_ORIGINS lists, with the session.
 */

const SIGN_IN = { message: "Sign in with GitHub to read and send feedback" };
const NOT_KEPT = { message: "Feedback is not kept on this server" };

/** GET /api/feedback?courseId=&labRoute=&stepId=: the step's feedback for the person signed in, from one read of its annotations. */
export const GET: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return answer(403, { message: "This origin may not read feedback" }, {});
  if (adapters().anonymous || !locals.actor) return answer(401, SIGN_IN, cors);
  const ref = parseStep(Object.fromEntries(url.searchParams));
  if (typeof ref === "string") return answer(400, { message: ref }, cors);
  const notes = feedback(fetch);
  if (!notes) return answer(503, NOT_KEPT, cors);
  const login = locals.actor.login;
  try {
    const educators = await notes.educatorsOf(ref.courseId).catch(() => [] as string[]);
    const shown = await notes.step(ref, login);
    if (!isEducatorOf(login, { educators })) return answer(200, { ...shown, history: null }, cors);
    const history = await notes.history(ref, { login });
    return answer(200, { ...shown, history: history.ok ? history.history : null }, cors);
  } catch (error) {
    log.error("Reading a step's feedback failed:", ref.courseId, error);
    return answer(503, { message: "The feedback could not be read" }, cors);
  }
};

/** POST /api/feedback: `{ action, ... }` as `parseFeedbackPost` reads it. */
export const POST: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return answer(403, { message: "This origin may not send feedback" }, {});
  if (adapters().anonymous || !locals.actor) return answer(401, SIGN_IN, cors);
  const post = parseFeedbackPost(await readJson(request, 16 * 1024));
  if (typeof post === "string") return answer(400, { message: post, reason: "invalid" }, cors);
  const notes = feedback(fetch);
  if (!notes) return answer(503, NOT_KEPT, cors);
  const actor = { login: locals.actor.login };
  if (post.action === "reflect") {
    const shared = await notes.reflect({ ref: post.ref, kind: post.kind, body: post.body, updatedAt: new Date(0).toISOString() }, actor.login);
    if (!shared.ok) return answer(shared.reason === "no-note" ? 400 : 503, { message: FEEDBACK_MESSAGES[shared.reason], reason: shared.reason }, cors);
    log.info("A reflection was shared", { courseId: post.ref.courseId });
    return answer(201, { reflection: shared.reflection }, cors);
  }
  const everyoneOnStep =
    post.action === "annotate" && post.input.audience.everyone && !post.input.audience.learnerId && !post.input.anchor.snippetId && !post.input.anchor.reflectionId;
  const result =
    post.action === "broadcast"
      ? await notes.broadcast(post.ref, post.body, actor, { stepTitle: post.stepTitle, senderName: locals.actor.name })
      : post.action === "revoke"
        ? await notes.revoke(post.id, actor)
        : everyoneOnStep
          ? await notes.broadcast(post.input.anchor.ref, post.input.body, actor, { senderName: locals.actor.name })
          : await notes.annotate(post.input, actor);
  if (!result.ok) {
    const detail = "detail" in result ? result.detail : undefined;
    return answer(result.status, { message: FEEDBACK_MESSAGES[result.reason], reason: result.reason, ...(detail ? { detail } : {}) }, cors);
  }
  log.info("Feedback changed", { action: post.action, courseId: result.annotation.anchor.ref.courseId, audience: result.annotation.audience.kind });
  return answer(post.action === "revoke" ? 200 : 201, { annotation: result.annotation }, cors);
};

/** The preflight for a lecturer's feedback from Tutors Live or Tutors Time, with the session. */
export const OPTIONS: RequestHandler = async ({ request, url }) => {
  const cors = allowedOriginHeaders(request, url, true);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }
  });
};
