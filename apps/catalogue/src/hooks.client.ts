import type { HandleClientError } from "@sveltejs/kit/hooks";
import log, { addTransport, setAppName } from "@tutors/logger";
import * as env from "$app/env/public";
import { dataApiErrorTransport } from "@tutors/data-api";
import { composeCatalogue } from "./lib/compose.ts";

const api = composeCatalogue(env);

setAppName("tutors-catalogue");
// Warnings and errors go to the reader's POST /api/errors (Rule 0472); the reader lists this origin in PRIVATE_API_ALLOWED_ORIGINS.
if (api) addTransport(dataApiErrorTransport("tutors-catalogue", api));

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
