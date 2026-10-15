import type { HandleClientError } from "@sveltejs/kit/hooks";
import * as env from "$app/env/public";
import log, { addTransport, setAppName } from "@tutors/logger";
import { createDataApi, dataApiErrorTransport } from "@tutors/data-api";
import { composeTime } from "./lib/compose.ts";
import { readerUrl, useReaderTimeSource } from "#lib/time-source.ts";

composeTime(env);
// The rows come from the reader's data API (PUBLIC_READER_URL); this app holds no database key for them.
useReaderTimeSource();

setAppName("tutors-time");
// Warnings and errors go to the reader's POST /api/errors (Rule 0472), which lists this origin in PRIVATE_API_ALLOWED_ORIGINS.
if (env.PUBLIC_ANON_MODE?.trim().toUpperCase() !== "TRUE") addTransport(dataApiErrorTransport("tutors-time", createDataApi(undefined, readerUrl())));

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
