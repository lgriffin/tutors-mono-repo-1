import type { HandleClientError } from "@sveltejs/kit/hooks";
import log, { addTransport, setAppName } from "@tutors/logger";
import * as env from "$app/env/public";
import { dataApiErrorTransport } from "@tutors/data-api";
import { configureAdapters } from "@tutors/svelte-state/adapters";
import { composeLive, liveDataApi } from "./lib/compose.ts";

configureAdapters(composeLive(env));

setAppName("tutors-live");
// Warnings and errors go to the reader's POST /api/errors (Rule 0472).
const api = liveDataApi(env);
if (api) addTransport(dataApiErrorTransport("tutors-live", api));

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
