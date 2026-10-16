import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { now } from "@tutors/clock";
import { storeHealth } from "#lib/server/snippets.ts";

/** The store is read by the server only (Rule 0472): the Postgres store at PRIVATE_DATABASE_URL. */
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
