import type { RequestHandler } from "./$types";
import { activityTopicOf, realtimeStream } from "@tutors/realtime-valkey";
import { liveRealtimeHub } from "#lib/server/realtime.ts";

/**
 * GET /api/realtime/stream?topic=: a course's or the platform's activity as server-sent events, for
 * Tutors Live's own pages, when PUBLIC_REALTIME is valkey (Rule 0482). Only activity topics are
 * streamed here (Rule 0483); playground shares and course notices are the reader's to stream.
 */
export const GET: RequestHandler = async ({ request, url }) => {
  const hub = liveRealtimeHub();
  if (!hub) return Response.json({ message: "Realtime is not served by this server" }, { status: 404 });
  const topic = activityTopicOf(url.searchParams.get("topic"));
  if (!topic) return Response.json({ message: "topic is not an activity topic Tutors Live streams" }, { status: 400 });
  return realtimeStream(hub, topic, { signal: request.signal });
};
