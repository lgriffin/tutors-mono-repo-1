import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isRangeName } from "@tutors/domain/live";
import { observationsFor } from "@tutors/application";
import { CACHE_TTL_MS, cacheHeaders, cached } from "#lib/server/cache.ts";
import { livePipeline } from "#lib/server/live.ts";

/** The observation cards. Term windows come from `LIVE_TERMS`; with none set, that rule stays quiet. */
export const GET: RequestHandler = async ({ url }) => {
  const range = url.searchParams.get("range") ?? "7d";
  if (!isRangeName(range)) error(400, `unknown range: ${range}`);

  const { warehouse, config } = await livePipeline();
  const observations = await cached(`observations:${range}`, CACHE_TTL_MS.observations, () =>
    observationsFor(warehouse, range, new Date(), config.terms)
  );
  return json({ observations }, { headers: cacheHeaders(CACHE_TTL_MS.observations) });
};
