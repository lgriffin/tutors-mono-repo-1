import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { clock } from "@tutors/clock";
import { broadcastToCourse, parseBroadcastMessage } from "@tutors/application";
import { adapters } from "@tutors/svelte-state/adapters";
import { broadcastLimiter, requireEducator, serverNotices } from "#lib/server/snippets.ts";

/**
 * POST /api/notices: a lecturer's broadcast to every student reading a course. The browser sends
 * the message here instead of publishing it; this checks the sender is an educator of the course
 * (its published enrollment), holds the one-per-minute limit, and publishes to the course's
 * broadcast topic over REST.
 */
export const POST: RequestHandler = async ({ request, locals, fetch }) => {
  if (adapters().anonymous) return new Response(null, { status: 204 });
  const body = (await request.json().catch(() => null)) as { courseId?: unknown } | null;
  const courseId = typeof body?.courseId === "string" ? body.courseId.trim().slice(0, 200) : "";
  if (!courseId) return json({ message: "courseId is required" }, { status: 400 });
  const message = parseBroadcastMessage(body);
  if (typeof message === "string") return json({ message }, { status: 400 });

  const actor = locals.actor;
  if (!actor) return json({ message: "Sign in with GitHub to broadcast" }, { status: 401 });
  const educator = await requireEducator(actor.login, courseId, fetch);
  if (!educator.ok) return json({ message: "Only an educator of the course may broadcast to it" }, { status: 403 });

  const result = await broadcastToCourse({ notices: serverNotices, clock, limiter: broadcastLimiter })(courseId, message, actor.name || actor.login);
  if (!result.ok) {
    if (result.reason === "rate-limited") return json({ message: "You can send one broadcast per minute" }, { status: 429 });
    return json({ message: "The broadcast was not sent" }, { status: result.reason === "empty" ? 400 : 502 });
  }
  return json({ id: result.broadcast.id, sentAt: result.broadcast.sentAt }, { status: 202 });
};
