import type { RequestHandler } from "@sveltejs/kit";
import { ALL_COURSES_CHANNEL } from "@tutors/realtime-supabase";
import { readerServer } from "#lib/server/api/adapters.ts";
import { allowedOriginHeaders, answer, preflight } from "#lib/server/api/cors.ts";
import * as check from "#lib/server/api/validate.ts";

/**
 * A Tutors Live tab reports the Realtime topic it watches, so the reader's server publishes to it
 * (POST /api/live/activity), and hears the day's budget tier. The server calls `realtime_watch` with
 * its service key (Rule 0472). Anonymous, as the anon key it replaces allowed; other origins only
 * from PRIVATE_API_ALLOWED_ORIGINS (Tutors Live's).
 */
export const POST: RequestHandler = async ({ request, url }) => {
  const cors = allowedOriginHeaders(request, url);
  if (!cors) return answer(403, { message: "This origin may not watch Live topics" }, {});
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return answer(415, { message: "Expected application/json" }, cors);
  const text = await request.text();
  if (text.length > 1024) return answer(413, { message: "Request body too large" }, cors);
  let body: { topic?: unknown; watcher?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { message: "Malformed JSON" }, cors);
  }
  // A Live activity topic: the platform's, or one course's (named by its course id).
  const topic = body?.topic === ALL_COURSES_CHANNEL ? ALL_COURSES_CHANNEL : check.courseId(body?.topic);
  const watcher = check.text(body?.watcher, 64);
  if (!topic || !watcher) return answer(400, { message: "topic is a Live activity topic and watcher an id" }, cors);
  const { data } = readerServer();
  if (!data) return answer(503, { message: "Tutors Live is not configured on this server" }, cors);
  return answer(200, { tier: await data.watchLive(topic, watcher) }, cors);
};

export const OPTIONS: RequestHandler = async ({ request, url }) => preflight(request, url, "POST");
