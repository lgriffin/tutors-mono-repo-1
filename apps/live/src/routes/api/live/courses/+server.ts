import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { coursesFor } from "@tutors/application";
import { CACHE_TTL_MS, cacheHeaders, cached } from "#lib/server/cache.ts";
import { livePipeline } from "#lib/server/live.ts";

/** The courses the filter offers. Cached as long as the heat maps: the list barely moves. */
export const GET: RequestHandler = async () => {
  const { warehouse } = await livePipeline();
  const courses = await cached("courses", CACHE_TTL_MS.heatmap, () => coursesFor(warehouse));
  return json({ courses }, { headers: cacheHeaders(CACHE_TTL_MS.heatmap) });
};
