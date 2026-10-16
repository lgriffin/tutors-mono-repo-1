import type { RequestHandler } from "./$types";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { admits, feedback } from "#lib/server/feedback.ts";
import { answer } from "#lib/server/api/cors.ts";

/**
 * GET /api/feedback/mine?courseId=: what the signed-in student received in the course, broadcasts
 * included and revoked ones left out, newest first (Rule 0409), in a course that admits them (Rule 0567).
 * Nobody reads another student's.
 */
export const GET: RequestHandler = async ({ url, locals, fetch }) => {
  if (adapters().anonymous || !locals.actor) return answer(401, { message: "Sign in with GitHub to read your feedback" }, {});
  const courseId = url.searchParams.get("courseId")?.trim() ?? "";
  if (!courseId) return answer(400, { message: "courseId is required" }, {});
  const notes = feedback(fetch);
  if (!notes) return answer(503, { message: "Feedback is not kept on this server" }, {});
  const admitted = await admits(courseId, locals.actor.login, fetch);
  if (admitted === null) return answer(503, { message: "The course could not be read; try again" }, {});
  if (!admitted) return answer(403, { message: "This course does not admit you" }, {});
  try {
    return answer(200, { annotations: await notes.received(courseId, locals.actor.login) }, {});
  } catch (error) {
    log.error("Reading a student's feedback failed:", courseId, error);
    return answer(503, { message: "Your feedback could not be read" }, {});
  }
};
