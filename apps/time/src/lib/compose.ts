/**
 * Tutors Time's composition root: the course notices the snippet dashboard watches through the
 * Realtime gateway, the only use of its Supabase client. The time rows come from the reader's data
 * API (lib/time-source.ts, Rules 0069, 0070) and errors go to the reader's POST /api/errors, so no
 * table is read or written from the browser (Rule 0471). Moodle, the snippet store and the health
 * check are composed on the server (lib/server/api/moodle.ts, lib/server/snippets.ts) from private
 * environment.
 */
import { createSupabaseClient } from "@tutors/store-supabase";
import { realtimeClientOptions, supabaseCourseNotices } from "@tutors/realtime-supabase";
import { anonymousAdapters, configureAdapters } from "@tutors/svelte-state/adapters";
import log, { withRequestId } from "@tutors/logger";

export type TimeEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_SUPABASE_URL?: string; PUBLIC_SUPABASE_ANON_KEY?: string };

export function composeTime(env: TimeEnv): void {
  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  const anonymous = env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
  const client = anonymous ? undefined : createSupabaseClient(url, key, withRequestId(), realtimeClientOptions());
  if (!client && !anonymous) {
    log.warn("Supabase is not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY missing); running without it");
  }
  // The dashboard only watches: the reader's server posts the snippet pings.
  configureAdapters(client ? { ...anonymousAdapters(), anonymous: false, notices: supabaseCourseNotices(client) } : anonymousAdapters());
}
