import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { now } from "@tutors/clock";

/**
 * The catalogue holds no database key: it reads through the reader's data API (Rule 0471), so there
 * is no database to check here and the error counts are the reader's /healthz.
 */
export const GET: RequestHandler = async () =>
  json({
    status: "ok",
    timestamp: now().toISOString(),
    app: "tutors-catalogue",
    checks: {
      store: { status: "skipped", latencyMs: 0, message: "reads through the reader's data API" }
    },
    errors: {
      last60min: []
    }
  });
