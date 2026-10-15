/**
 * Tutors Live's composition root: presence over Supabase Realtime, or nothing in anonymous mode.
 * Live only listens; it records no learner and has no sign-in. Its Supabase client carries the
 * Realtime channels and nothing else: the stored roster and the watcher reports go to the reader's
 * data API at PUBLIC_READER_URL (Rule 0471), which lists this origin in PRIVATE_API_ALLOWED_ORIGINS.
 * With PUBLIC_REALTIME=valkey there is no Supabase client: presence streams from Live's own server
 * (GET /api/realtime/stream, Rule 0482) and reports no watcher, as there is no budget; a course's
 * help queue streams from the reader's server with the lecturer's session (Rule 0392), and is not
 * offered on Supabase Realtime. On either, the queue is read and worked through the reader's
 * /api/assistance with the session (the help desk).
 */
import { anonymousAdapters, type Adapters } from "@tutors/svelte-state/adapters";
import { clock } from "@tutors/clock";
import { createSupabaseClient } from "@tutors/store-supabase";
import { realtimeClientOptions, supabasePresence } from "@tutors/realtime-supabase";
import { realtimeKindOf, sseAssistanceFeed, valkeyBrowserRealtime } from "@tutors/realtime-valkey";
import { createDataApi, readerApiHelpDesk, readerApiLiveWatch, readerApiPresenceRoster, type DataApi } from "@tutors/data-api";
import log, { withRequestId } from "@tutors/logger";

export type LiveEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_SUPABASE_URL?: string; PUBLIC_SUPABASE_ANON_KEY?: string; PUBLIC_READER_URL?: string; PUBLIC_REALTIME?: string };

/** The reader's data API, or null in anonymous mode. */
export function liveDataApi(env: LiveEnv): DataApi | null {
  if (env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE") return null;
  return createDataApi(undefined, env.PUBLIC_READER_URL?.trim() || "https://tutors.dev");
}

export function composeLive(env: LiveEnv): Adapters {
  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  const api = liveDataApi(env);
  if (api && realtimeKindOf(env) === "valkey") {
    return {
      ...anonymousAdapters({ clock }),
      anonymous: false,
      presence: valkeyBrowserRealtime({ presence: { roster: readerApiPresenceRoster(api) } }).presence,
      // The help queue streams from the reader, which checks the lecturer's session (Rule 0392).
      assistanceFeed: sseAssistanceFeed({ streamBase: api.base }),
      helpDesk: readerApiHelpDesk(api)
    };
  }
  const client = api ? createSupabaseClient(url, key, withRequestId(), realtimeClientOptions()) : undefined;
  if (!client || !api) {
    if (api) log.warn("Supabase is not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY missing); running without it");
    return anonymousAdapters({ clock });
  }
  return {
    ...anonymousAdapters({ clock }),
    anonymous: false,
    presence: supabasePresence(client, clock.now, { roster: readerApiPresenceRoster(api), watch: readerApiLiveWatch(api) }),
    // No stream of the help queue on Supabase Realtime: the queue is read from stored rows every minute (Rule 0393).
    helpDesk: readerApiHelpDesk(api)
  };
}
