/**
 * Tutors Time's composition root: the Supabase store for the error transport and health check,
 * the time library's own client for its analytics reads, and the course notices the snippet
 * dashboard watches through the Realtime gateway. Moodle and the snippet store are composed on
 * the server (lib/server/api/moodle.ts, lib/server/snippets.ts) from private environment.
 */
import { configureSupabase, createSupabaseClient } from "@tutors/store-supabase";
import { realtimeClientOptions, supabaseCourseNotices } from "@tutors/realtime-supabase";
import { anonymousAdapters, configureAdapters } from "@tutors/svelte-state/adapters";
import { initSupabase } from "@tutors/tutors-time-lib";
import log, { withRequestId } from "@tutors/logger";

export type TimeEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_SUPABASE_URL?: string; PUBLIC_SUPABASE_ANON_KEY?: string };

export function composeTime(env: TimeEnv): void {
  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  const anonymous = env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
  const client = anonymous ? undefined : createSupabaseClient(url, key, withRequestId(), realtimeClientOptions());
  configureSupabase(client, client ? { url: url!, key: key! } : undefined);
  initSupabase(url ?? "", key ?? "");
  if (!client && !anonymous) {
    log.warn("Supabase is not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY missing); running without it");
  }
  // The dashboard only watches: the reader's server posts the snippet pings.
  configureAdapters(client ? { ...anonymousAdapters(), anonymous: false, notices: supabaseCourseNotices(client) } : anonymousAdapters());
}
