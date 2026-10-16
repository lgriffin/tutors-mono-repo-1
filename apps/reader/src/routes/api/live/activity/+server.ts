import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { MAX_LIVE_ACTIVITY_BYTES } from "@tutors/domain/presence";
import { readerServer } from "#lib/server/api/adapters.ts";

/**
 * Tutors Live's activity feed: the reader posts each learning event here, and the server publishes
 * it to the course's and the platform's activity topics on Valkey (publishLiveActivity, Rule 0481).
 */
export const POST: RequestHandler = async ({ request }) => {
  // Refuse an oversized body before reading it, when the client says how big it is.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_LIVE_ACTIVITY_BYTES) {
    return json({ message: "body is larger than 4 KB" }, { status: 400 });
  }
  const result = await readerServer().realtime.activity(await request.text());
  return result.body === undefined ? new Response(null, { status: result.status }) : json(result.body, { status: result.status });
};
