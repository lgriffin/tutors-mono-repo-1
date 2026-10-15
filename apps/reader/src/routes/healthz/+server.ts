import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { now } from "@tutors/clock";
import { readerServer } from "#lib/server/api/adapters.ts";

/** The store is read by the server, never with the browser's anon key (Rule 0472); the check is named for the store DATA_STORE picks. */
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
      [data?.store ?? "supabase"]: storeCheck
    },
    errors: {
      last60min: errorCounts
    }
  });
};
