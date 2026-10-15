import type { RequestHandler } from "./$types";
import log from "@tutors/logger";
import { ingestPreflight, ingestRequest } from "#lib/server/ingest.ts";
import { livePipeline } from "#lib/server/live.ts";

/**
 * The only door into the pipeline: the reader posts batches of live events
 * here and they are published on the bus. See `ingestRequest` for what is and
 * is not trusted about a batch that arrived unauthenticated.
 */

export const OPTIONS: RequestHandler = () => ingestPreflight();

export const POST: RequestHandler = async ({ request }) => {
  const { bus } = await livePipeline();
  return ingestRequest(request, bus, {
    onRejected: (rejected) => log.warn("live events rejected", { rejected: rejected.length, first: rejected[0]?.reason })
  });
};
