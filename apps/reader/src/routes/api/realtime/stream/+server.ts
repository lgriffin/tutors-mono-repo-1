import type { RequestHandler } from "@sveltejs/kit";
import { realtimeStream, streamableTopic } from "@tutors/realtime-valkey";
import { readerServer } from "#lib/server/api/adapters.ts";
import { allowedOriginHeaders, answer } from "#lib/server/api/cors.ts";

/**
 * GET /api/realtime/stream?topic=: one realtime topic as server-sent events, when PUBLIC_REALTIME is
 * valkey (Rule 0482). The reader's own tabs stream course broadcasts and playground shares here;
 * Tutors Time's snippets page streams a course's snippet pings from its origin, which
 * PRIVATE_API_ALLOWED_ORIGINS lists. Only topics Tutors publishes are streamed (Rule 0483).
 */
export const GET: RequestHandler = async ({ request, url }) => {
  const cors = allowedOriginHeaders(request, url);
  if (!cors) return answer(403, { message: "This origin may not stream realtime topics" }, {});
  const { hub } = readerServer().realtime;
  if (!hub) return answer(404, { message: "Realtime is not served by this server" }, cors);
  const topic = streamableTopic(url.searchParams.get("topic"));
  if (!topic) return answer(400, { message: "topic is not a realtime topic Tutors publishes" }, cors);
  return realtimeStream(hub, topic, { signal: request.signal, headers: cors });
};
