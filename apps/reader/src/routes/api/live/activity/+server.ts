import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { MAX_LIVE_ACTIVITY_BYTES, receiveLiveActivity } from "@tutors/realtime-supabase";
import { readerServer } from "#lib/server/api/adapters.ts";

/**
 * Tutors Live's activity feed: the reader posts each learning event here, and this publishes it to the
 * Realtime topics a Live tab is watching, within the day's budget. The budget claim is made with the
 * server's service client (the anon key can call no database function, Rule 0472); without one
 * (anonymous mode, or no service key) nothing is published.
 * See receiveLiveActivity.
 */
export const POST: RequestHandler = async ({ request }) => {
  // Refuse an oversized body before reading it, when the client says how big it is.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_LIVE_ACTIVITY_BYTES) {
    return json({ message: "body is larger than 4 KB" }, { status: 400 });
  }
  const result = await receiveLiveActivity(await request.text(), readerServer().data?.db);
  return result.body === undefined ? new Response(null, { status: result.status }) : json(result.body, { status: result.status });
};
