/**
 * Tutors Time's composition root: the course notices the snippet dashboard watches, streamed from
 * the reader's server at PUBLIC_READER_URL over Valkey (GET /api/realtime/stream, Rule 0482). The
 * time rows come from the reader's data API (lib/time-source.ts, Rules 0069, 0070) and errors go to
 * the reader's POST /api/errors, so no table is read or written from the browser (Rule 0471).
 * Moodle, the snippet store and the health check are composed on the server
 * (lib/server/api/moodle.ts, lib/server/snippets.ts) from private environment. A lecturer's
 * feedback on a snippet is posted to that reader's /api/feedback with the session, and the insights
 * pages read that reader's GET /api/insights with it (Rules 0412 to 0414).
 */
import { valkeyBrowserRealtime } from "@tutors/realtime-valkey";
import { anonymousAdapters, configureAdapters } from "@tutors/svelte-state/adapters";
import { createDataApi, readerApiFeedbackDesk, readerApiInsightsDesk } from "@tutors/data-api";

export type TimeEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_READER_URL?: string };

export function composeTime(env: TimeEnv): void {
  if (env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE") {
    configureAdapters(anonymousAdapters());
    return;
  }
  const reader = env.PUBLIC_READER_URL?.trim() || "https://tutors.dev";
  const api = createDataApi(undefined, reader);
  configureAdapters({
    ...anonymousAdapters(),
    anonymous: false,
    // The dashboard only watches: the reader's server posts the snippet pings.
    notices: valkeyBrowserRealtime({ streamBase: reader, publishBase: reader }).notices,
    feedbackDesk: readerApiFeedbackDesk(api),
    insightsDesk: readerApiInsightsDesk(api)
  });
}
