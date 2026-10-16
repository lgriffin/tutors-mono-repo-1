/**
 * Tutors Live's composition root: presence streamed from Live's own server over Valkey (GET
 * /api/realtime/stream, Rule 0482), or nothing in anonymous mode. Live only listens; it records no
 * learner and has no sign-in. The stored roster comes from the reader's data API at
 * PUBLIC_READER_URL (Rule 0471), which lists this origin in PRIVATE_API_ALLOWED_ORIGINS. A course's
 * help queue streams from the reader's server with the lecturer's session (Rule 0392), is read and
 * worked through the reader's /api/assistance with the session (the help desk), and a resolved
 * request is posted as an explanation for everyone on its step through the reader's /api/feedback
 * (the feedback desk).
 */
import { anonymousAdapters, type Adapters } from "@tutors/svelte-state/adapters";
import { clock } from "@tutors/clock";
import { sseAssistanceFeed, valkeyBrowserRealtime } from "@tutors/realtime-valkey";
import { createDataApi, readerApiFeedbackDesk, readerApiHelpDesk, readerApiPresenceRoster, type DataApi } from "@tutors/data-api";

export type LiveEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_READER_URL?: string };

/** The reader's data API, or null in anonymous mode. */
export function liveDataApi(env: LiveEnv): DataApi | null {
  if (env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE") return null;
  return createDataApi(undefined, env.PUBLIC_READER_URL?.trim() || "https://tutors.dev");
}

export function composeLive(env: LiveEnv): Adapters {
  const api = liveDataApi(env);
  if (!api) return anonymousAdapters({ clock });
  return {
    ...anonymousAdapters({ clock }),
    anonymous: false,
    presence: valkeyBrowserRealtime({ presence: { roster: readerApiPresenceRoster(api) } }).presence,
    // The help queue streams from the reader, which checks the lecturer's session (Rule 0392).
    assistanceFeed: sseAssistanceFeed({ streamBase: api.base }),
    helpDesk: readerApiHelpDesk(api),
    // A resolved request is turned into an explanation for everyone through the reader's /api/feedback (Rule 0407).
    feedbackDesk: readerApiFeedbackDesk(api)
  };
}
