import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isHeatmapKind, isRangeName } from "@tutors/domain/live";
import { heatmapFor } from "@tutors/application";
import { CACHE_TTL_MS, cacheHeaders, cached } from "#lib/server/cache.ts";
import { livePipeline } from "#lib/server/live.ts";

/** One heat map as `{ x, y, cells }`, ready for the SVG to draw without further shaping. */
export const GET: RequestHandler = async ({ url }) => {
  const kind = url.searchParams.get("kind") ?? "service";
  if (!isHeatmapKind(kind)) error(400, `unknown heat map: ${kind}`);
  const range = url.searchParams.get("range") ?? "7d";
  if (!isRangeName(range)) error(400, `unknown range: ${range}`);
  const course = url.searchParams.get("course");

  const { warehouse } = await livePipeline();
  const matrix = await cached(`heatmap:${kind}:${range}:${course ?? ""}`, CACHE_TTL_MS.heatmap, () =>
    heatmapFor(warehouse, kind, range, course)
  );
  return json(matrix, { headers: cacheHeaders(CACHE_TTL_MS.heatmap) });
};
