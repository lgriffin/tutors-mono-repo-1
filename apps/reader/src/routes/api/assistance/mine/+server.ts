import type { RequestHandler } from "./$types";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { assistance } from "#lib/server/assistance.ts";
import { answer } from "#lib/server/api/cors.ts";

/**
 * GET /api/assistance/mine?courseId=: the signed-in student's own live help request in the course,
 * or null, read from stored rows. A student's reader never streams the course's help queue (Rule 0392).
 */
export const GET: RequestHandler = async ({ url, locals, fetch }) => {
  if (adapters().anonymous || !locals.actor) return answer(401, { message: "Sign in with GitHub to ask for help" }, {});
  const courseId = url.searchParams.get("courseId")?.trim() ?? "";
  if (!courseId) return answer(400, { message: "courseId is required" }, {});
  const help = assistance(fetch);
  if (!help) return answer(503, { message: "Help requests are not kept on this server" }, {});
  try {
    return answer(200, { request: await help.mine(courseId, locals.actor.login) }, {});
  } catch (error) {
    log.error("Reading a student's help request failed:", courseId, error);
    return answer(503, { message: "Your help request could not be read" }, {});
  }
};
