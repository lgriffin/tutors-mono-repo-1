/**
 * The reader's composition root: which adapter sits behind each port, decided from the
 * environment and nowhere else. `PUBLIC_ANON_MODE=TRUE` composes a reader that records nothing,
 * shows nobody present and offers no sign-in; otherwise the learner's record, presence snapshot,
 * locks, whiteboard scenes, SCORM state and playground hand-ins travel through the reader's own
 * data API (@tutors/data-api; the server reads and writes them with its service key,
 * guides/SERVER-WRITES.md), the browser's Supabase client carries only the Realtime channels, and
 * Better Auth the session. Both hooks files call this once, so the server and the browser run the same
 * wiring; tests call it with the environment they want.
 */
import type { IdentityClient } from "@tutors/application/ports";
import { anonymousAdapters, type Adapters } from "@tutors/svelte-state/adapters";
import { clock } from "@tutors/clock";
import { markdownRenderer } from "@tutors/render-markdown";
import { httpCourseSource, httpSnippetStore } from "@tutors/course-http";
import { localStorageProfile } from "@tutors/profile-localstorage";
import { localStorageNotes } from "@tutors/notes-localstorage";
import { inProcessPublisher } from "@tutors/bus-inprocess";
import { wasmCodeRuntime } from "@tutors/runtime-wasm";
import { indexedDbWorkspaceStore } from "@tutors/workspace-indexeddb";
import { httpLiveEventReporter } from "@tutors/live-events-http";
import { createSupabaseClient } from "@tutors/store-supabase";
import { realtimeClientOptions, supabaseCourseNotices, supabasePlaygroundLive, supabasePresence } from "@tutors/realtime-supabase";
import {
  readerApiAccessStore,
  readerApiCourseVisit,
  readerApiLearningEventSink,
  readerApiPlaygroundSnapshots,
  readerApiLiveWatch,
  readerApiPresenceRoster,
  readerApiPresenceStore,
  readerApiProfile,
  readerApiScormRecords,
  readerApiWhiteboardStore
} from "@tutors/data-api";
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
    // A learner's notes stay in their own browser in every mode (decision D1, Rule 0380).
    notes: localStorageNotes(),
    // Live events are anonymous, so they are reported in every mode, and only from a reader in
    // front of a person: a render on the server posts nothing.
    liveEvents: httpLiveEventReporter({
      endpoint: typeof document === "undefined" ? undefined : env.PUBLIC_LIVE_EVENTS_URL || undefined,
      onError: (error) => log.debug("live events could not be posted", { error: String(error) })
    }),
    identityClient: options.identityClient ?? null
  };

  if (isAnonymous(env)) return anonymousAdapters(shared);

  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.PUBLIC_SUPABASE_ANON_KEY;
  // The Realtime gateway's client, and nothing else: it reads and writes no table (Rule 0471). On the
  // server, calls made while serving a request carry its x-request-id; in the browser this is plain fetch.
  const client = createSupabaseClient(url, key, withRequestId(), realtimeClientOptions());
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

  // The presence snapshot is stored by the server (POST /api/presence); the channel itself stays in the browser.
  const presence = supabasePresence(client, clock.now, {
    store: readerApiPresenceStore(),
    roster: readerApiPresenceRoster(),
    watch: readerApiLiveWatch()
  });
  return {
    ...anonymousAdapters(shared),
    anonymous: false,
    learningEvents: readerApiLearningEventSink(),
    presence,
    profile: { local: localStorageProfile(), signedIn: readerApiProfile() },
    accessStore: readerApiAccessStore(),
    whiteboard: readerApiWhiteboardStore(),
    scormRecords: readerApiScormRecords(),
    // Snapshots have an owner: the server keeps them under the session's login and decides who may read them (Rule 0475).
    playgroundSnapshots: readerApiPlaygroundSnapshots(),
    // TODO(budget): the live share is browser-published through the gateway; see realtime-supabase/src/playground-live.ts.
    playgroundLive: supabasePlaygroundLive(presence.gateway),
    // A shared snippet goes to the reader's server, which keeps it with its service key; notices
    // (a lecturer's broadcast, a snippet ping) are posted to the server too and watched through the gateway.
    snippets: httpSnippetStore(),
    notices: supabaseCourseNotices(client)
  };
}
