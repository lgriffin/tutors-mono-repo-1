import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { checkSupabase, getRecentErrorCounts } from "@tutors/store-supabase";
import { now } from "@tutors/clock";
import { readerServer } from "#lib/server/api/adapters.ts";

/** The database is read with the server's service client; the browser's anon key reads nothing (Rule 0472). */
export const GET: RequestHandler = async () => {
  const db = readerServer().data?.db;
  const [supabaseCheck, errorCounts] = await Promise.all([checkSupabase(db), getRecentErrorCounts(db)]);

  const overallStatus = supabaseCheck.status === "ok" || supabaseCheck.status === "skipped" ? "ok" : "degraded";

  return json({
    status: overallStatus,
    timestamp: now().toISOString(),
    app: "tutors-reader",
    checks: {
      supabase: supabaseCheck
    },
    errors: {
      last60min: errorCounts
    }
  });
};
