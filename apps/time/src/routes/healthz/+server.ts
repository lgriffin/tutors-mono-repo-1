import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { checkSupabase, getRecentErrorCounts } from "@tutors/store-supabase";
import { now } from "@tutors/clock";
import { serviceClient } from "#lib/server/snippets.ts";

/** The database is read with the server's service client; the browser's anon key reads nothing (Rule 0472). */
export const GET: RequestHandler = async () => {
  const db = serviceClient();
  const [supabaseCheck, errorCounts] = await Promise.all([checkSupabase(db), getRecentErrorCounts(db)]);

  const overallStatus = supabaseCheck.status === "ok" || supabaseCheck.status === "skipped" ? "ok" : "degraded";

  return json({
    status: overallStatus,
    timestamp: now().toISOString(),
    app: "tutors-time",
    checks: {
      supabase: supabaseCheck
    },
    errors: {
      last60min: errorCounts
    }
  });
};
