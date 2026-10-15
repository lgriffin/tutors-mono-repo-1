import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { now } from "@tutors/clock";
import { storeHealth } from "#lib/server/snippets.ts";

/** The store is read by the server, never with the browser's anon key (Rule 0472); the check is named for the store DATA_STORE picks. */
export const GET: RequestHandler = async () => {
  const health = storeHealth();
  const [storeCheck, errorCounts] = await Promise.all([health.check(), health.errorCounts()]);

  const overallStatus = storeCheck.status === "ok" || storeCheck.status === "skipped" ? "ok" : "degraded";

  return json({
    status: overallStatus,
    timestamp: now().toISOString(),
    app: "tutors-time",
    checks: {
      [health.store]: storeCheck
    },
    errors: {
      last60min: errorCounts
    }
  });
};
