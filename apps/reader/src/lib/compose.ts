/**
 * The reader's composition root: which adapter sits behind each port, decided from the
 * environment and nowhere else. `PUBLIC_ANON_MODE=TRUE` composes a reader that records nothing,
 * shows nobody present and offers no sign-in; otherwise the learner's record, presence snapshot,
 * locks and whiteboard scenes travel through the reader's own data API (@tutors/data-api; the
 * server writes them with its service key, guides/SERVER-WRITES.md), Supabase holds only the public
 * reads (the catalogue, the locks, the latest presence) and the Realtime channels, and Better Auth
 * the session. Both hooks files call this once, so the server and the browser run the same
 * wiring; tests call it with the environment they want.
 */
import type { IdentityClient } from "@tutors/application/ports";
import { anonymousAdapters, type Adapters } from "@tutors/svelte-state/adapters";
import { clock } from "@tutors/clock";
import { markdownRenderer } from "@tutors/render-markdown";
import { httpCourseSource } from "@tutors/course-http";
import { localStorageProfile } from "@tutors/profile-localstorage";
import { inProcessPublisher } from "@tutors/bus-inprocess";
import { configureSupabase, createSupabaseClient, supabaseAccessStore } from "@tutors/store-supabase";
import { realtimeClientOptions, supabasePresence } from "@tutors/realtime-supabase";
import {
  readerApiAccessStore,
  readerApiCourseVisit,
  readerApiLearningEventSink,
  readerApiPresenceStore,
  readerApiProfile,
  readerApiWhiteboardStore
} from "@tutors/data-api";
import log, { withRequestId } from "@tutors/logger";

export type ReaderEnv = {
  PUBLIC_ANON_MODE?: string;
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_ANON_KEY?: string;
};

/** `PUBLIC_ANON_MODE=TRUE` turns the learner record, presence and sign-in off entirely. */
function isAnonymous(env: ReaderEnv): boolean {
  return env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE";
}

export function composeReader(env: ReaderEnv, options: { identityClient?: IdentityClient | null } = {}): Adapters {
  const publisher = inProcessPublisher((error) => log.error("An event subscriber failed:", error));
  const shared: Partial<Adapters> = {
    clock,
    renderer: markdownRenderer,
    courseSource: httpCourseSource(),
    profile: { local: localStorageProfile(), signedIn: null },
    publisher,
    identityClient: options.identityClient ?? null
  };

  if (isAnonymous(env)) {
    configureSupabase(undefined);
    return anonymousAdapters(shared);
  }

  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  // On the server, calls made while serving a request carry its x-request-id; in the browser this is plain fetch.
  const client = createSupabaseClient(url, key, withRequestId(), realtimeClientOptions());
  configureSupabase(client, client ? { url: url!, key: key! } : undefined);
  if (!client) {
    log.warn("Supabase is not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY missing); running without it");
    return { ...anonymousAdapters(shared), anonymous: false };
  }

  // The catalogue counts every course visit; it listens rather than being called from the reader,
  // and the count is written by the server (POST /api/courses/visit) from the published course.
  const reportVisit = readerApiCourseVisit();
  publisher.subscribe((event) => {
    if (event.type === "course-visit") void reportVisit(event.course, clock.now());
  });

  return {
    ...anonymousAdapters(shared),
    anonymous: false,
    learningEvents: readerApiLearningEventSink(),
    presence: supabasePresence(client, clock.now, { store: readerApiPresenceStore() }),
    profile: { local: localStorageProfile(), signedIn: readerApiProfile() },
    accessStore: readerApiAccessStore(supabaseAccessStore().locks),
    whiteboard: readerApiWhiteboardStore()
  };
}
