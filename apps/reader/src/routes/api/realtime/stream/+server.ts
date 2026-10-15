import type { RequestHandler } from "@sveltejs/kit";
import { playgroundOf, realtimeStream, streamableTopic } from "@tutors/realtime-valkey";
import { readerServer } from "#lib/server/api/adapters.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";
import { requireEducator } from "#lib/server/snippets.ts";

/**
 * GET /api/realtime/stream?topic=: one realtime topic as server-sent events, when PUBLIC_REALTIME is
 * valkey (Rule 0482). The reader's own tabs stream course broadcasts and playground shares here;
 * Tutors Time's snippets page streams a course's snippet pings from its origin, which
 * PRIVATE_API_ALLOWED_ORIGINS lists. Only topics Tutors publishes are streamed (Rule 0483), and a
 * playground share's work only to a signed-in educator of its course (Rule 0560).
 */
export const GET: RequestHandler = async ({ request, url, locals, fetch }) => {
  const cors = allowedOriginHeaders(request, url);
  if (!cors) return answer(403, { message: "This origin may not stream realtime topics" }, {});
  const { hub } = readerServer().realtime;
  if (!hub) return answer(404, { message: "Realtime is not served by this server" }, cors);
  const raw = url.searchParams.get("topic");
  const topic = streamableTopic(raw);
  if (!topic) return answer(400, { message: "topic is not a realtime topic Tutors publishes" }, cors);
  const playground = playgroundOf(raw);
  if (!playground) return realtimeStream(hub, topic, { signal: request.signal, headers: cors });
  const actor = locals.actor;
  if (!actor) return answer(401, { message: "Sign in with GitHub to share or watch live" }, cors);
  const educator = (await requireEducator(actor.login, playground.courseId, fetch)).ok;
  // A sharing student hears only that a lecturer is watching; a lecturer also sees the work.
  return realtimeStream(hub, topic, { signal: request.signal, headers: cors, ...(educator ? {} : { only: (message) => message.event === "watching" }) });
};
