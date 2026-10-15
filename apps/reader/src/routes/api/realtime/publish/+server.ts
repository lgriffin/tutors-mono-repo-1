import type { RequestHandler } from "@sveltejs/kit";
import { MAX_BROWSER_MESSAGE_BYTES, publishBrowserMessage, topicRateLimiter } from "@tutors/realtime-valkey";
import { readerServer } from "#lib/server/api/adapters.ts";
import { answer } from "#lib/server/api/cors.ts";
import { requireEducator } from "#lib/server/snippets.ts";

/** One limiter for the server's lifetime, across every browser it answers. */
const allow = topicRateLimiter();

/**
 * POST /api/realtime/publish: a signed-in reader tab's message for a playground live share (a
 * student's own `state`, an educator's `watching`), published to Valkey when PUBLIC_REALTIME is
 * valkey. Only the reader's own pages may post, and only to a playground topic (Rule 0484).
 */
export const POST: RequestHandler = async ({ request, url, locals, fetch }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return answer(403, { message: "Only the reader's own pages may publish" }, {});
  const { hub } = readerServer().realtime;
  if (!hub) return answer(404, { message: "Realtime is not served by this server" }, {});
  const actor = locals.actor;
  if (!actor) return answer(401, { message: "Sign in with GitHub to share or watch live" }, {});
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return answer(415, { message: "Expected application/json" }, {});
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BROWSER_MESSAGE_BYTES) return answer(413, { message: "body is larger than 256 KB" }, {});
  const sender = { login: actor.login, isEducator: async (courseId: string) => (await requireEducator(actor.login, courseId, fetch)).ok };
  const result = await publishBrowserMessage(await request.text(), hub, allow, sender);
  return result.status === 202 ? new Response(null, { status: 202 }) : answer(result.status, { message: result.message }, {});
};
