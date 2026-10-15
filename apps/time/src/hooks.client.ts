import type { HandleClientError } from "@sveltejs/kit/hooks";
import * as env from "$app/env/public";
import log, { addTransport, setAppName } from "@tutors/logger";
import { createSupabaseErrorTransport } from "@tutors/store-supabase";
import { composeTime } from "./lib/compose.ts";
import { useReaderTimeSource } from "#lib/time-source.ts";

composeTime(env);
// The rows come from the reader's data API (PUBLIC_READER_URL); this app holds no database key for them.
useReaderTimeSource();

setAppName("tutors-time");
addTransport(createSupabaseErrorTransport("tutors-time"));

window.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection", {
    reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
    stack: event.reason instanceof Error ? event.reason.stack : undefined
  });
});

export const handleError: HandleClientError = ({ kind, error }) => {
  if (kind !== "unknown") return;
  log.error("Client error:", error instanceof Error ? error : { details: error });
  return {
    status: 500,
    message: "An unexpected error occurred"
  };
};
