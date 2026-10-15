/**
 * The reader's composition root: which adapter sits behind each port, decided from the
 * environment and nowhere else. `PUBLIC_ANON_MODE=TRUE` composes a reader that records nothing,
 * shows nobody present and offers no sign-in; otherwise Supabase holds the learner's record and
 * presence, and Better Auth the session. Both hooks files call this once, so the server and the
 * browser run the same wiring; tests call it with the environment they want.
 */
import type { IdentityClient } from "@tutors/application/ports";
import { anonymousAdapters, type Adapters } from "@tutors/svelte-state/adapters";
import { clock } from "@tutors/clock";
import { markdownRenderer } from "@tutors/render-markdown";
import { httpCourseSource, httpSnippetStore } from "@tutors/course-http";
import { localStorageProfile } from "@tutors/profile-localstorage";
import { inProcessPublisher } from "@tutors/bus-inprocess";
import { wasmCodeRuntime } from "@tutors/runtime-wasm";
import { indexedDbWorkspaceStore } from "@tutors/workspace-indexeddb";
import { httpLiveEventReporter } from "@tutors/live-events-http";
import {
  configureSupabase,
  createSupabaseClient,
  supabaseAccessStore,
  supabaseLearningEventSink,
  supabasePlaygroundSnapshots,
  supabaseProfile,
  supabaseScormRecords,
  updateCourseList
} from "@tutors/store-supabase";
import { realtimeClientOptions, supabaseCourseNotices, supabasePlaygroundLive, supabasePresence } from "@tutors/realtime-supabase";
import { initSupabase } from "@tutors/tutors-time-lib";
import log, { withRequestId } from "@tutors/logger";

export type ReaderEnv = {
  PUBLIC_ANON_MODE?: string;
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_ANON_KEY?: string;
  /** Where Tutors Live's ingest endpoint is; unset, the reader reports nothing to it. */
  PUBLIC_LIVE_EVENTS_URL?: string;
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
    // Student code runs in the browser whatever the deployment: the engine is a sandboxed
    // frame on the reader's own host, and the work stays in the student's own browser.
    codeRuntime: wasmCodeRuntime(),
    workspaces: indexedDbWorkspaceStore(),
    // Live events are anonymous, so they are reported in every mode, and only from a reader in
    // front of a person: a render on the server posts nothing.
    liveEvents: httpLiveEventReporter({
      endpoint: typeof document === "undefined" ? undefined : env.PUBLIC_LIVE_EVENTS_URL || undefined,
      onError: (error) => log.debug("live events could not be posted", { error: String(error) })
    }),
    identityClient: options.identityClient ?? null
  };

  if (isAnonymous(env)) {
    configureSupabase(undefined);
    return anonymousAdapters(shared);
  }

  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  // On the server, calls made while serving a request carry its x-request-id; in the browser this is plain fetch.
  initSupabase(url ?? "", key ?? "");
  const client = createSupabaseClient(url, key, withRequestId(), realtimeClientOptions());
  configureSupabase(client, client ? { url: url!, key: key! } : undefined);
  if (!client) {
    log.warn("Supabase is not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY missing); running without it");
    return { ...anonymousAdapters(shared), anonymous: false };
  }

  // The catalogue counts every course visit; it listens rather than being called from the reader.
  publisher.subscribe((event) => {
    if (event.type === "course-visit") void updateCourseList(event.course, clock.now());
  });

  const presence = supabasePresence(client, clock.now);
  return {
    ...anonymousAdapters(shared),
    anonymous: false,
    learningEvents: supabaseLearningEventSink(),
    presence,
    profile: { local: localStorageProfile(), signedIn: supabaseProfile() },
    accessStore: supabaseAccessStore(),
    whiteboardClient: client,
    scormRecords: supabaseScormRecords(),
    // Snapshots have an owner, so they are written as the signed-in student with a token the
    // reader mints at /api/runtime-token (PRIVATE_SUPABASE_JWT_SECRET); without it, nothing is handed in.
    playgroundSnapshots: supabasePlaygroundSnapshots({ url: url!, key: key! }),
    // TODO(budget): the live share is browser-published through the gateway; see realtime-supabase/src/playground-live.ts.
    playgroundLive: supabasePlaygroundLive(presence.gateway),
    // A shared snippet goes to the reader's server, which keeps it with its service key; notices
    // (a lecturer's broadcast, a snippet ping) are posted to the server too and watched through the gateway.
    snippets: httpSnippetStore(),
    notices: supabaseCourseNotices(client)
  };
}
