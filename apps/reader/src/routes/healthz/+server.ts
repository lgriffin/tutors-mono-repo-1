import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { now } from "@tutors/clock";
import { readerServer } from "#lib/server/api/adapters.ts";

/** The store is read by the server only (Rule 0472): the Postgres store at PRIVATE_DATABASE_URL. */
export const GET: RequestHandler = async () => {
  const data = readerServer().data;
  const [storeCheck, errorCounts] = data
    ? await Promise.all([data.health.check(), data.health.errorCounts()])
    : [{ status: "skipped" as const, latencyMs: 0, message: "no database client on this server" }, []];

  const overallStatus = storeCheck.status === "ok" || storeCheck.status === "skipped" ? "ok" : "degraded";

  return json({
    status: overallStatus,
    timestamp: now().toISOString(),
    app: "tutors-reader",
    checks: {
      postgres: storeCheck
    },
    errors: {
      last60min: errorCounts
    }
  });
};
