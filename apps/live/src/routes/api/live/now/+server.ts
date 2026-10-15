import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { CACHE_TTL_MS, cacheHeaders, cached } from "#lib/server/cache.ts";
import { livePipeline } from "#lib/server/live.ts";

/** Who is active right now, straight off the hot store. */
export const GET: RequestHandler = async () => {
  const { hot } = await livePipeline();
  const snapshot = await cached("now", CACHE_TTL_MS.now, () => hot.now());
  return json(snapshot, { headers: cacheHeaders(CACHE_TTL_MS.now) });
};
