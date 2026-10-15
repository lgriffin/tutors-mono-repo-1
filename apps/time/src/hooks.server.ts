/* global APP_VERSION */
import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { sequence } from "@sveltejs/kit/hooks";
import { building } from "$app/env";
import log, { createRequestLogger, installProcessLogging, logRequestError, logServiceStart, setAppName } from "@tutors/logger";
import { metricsHandle } from "@tutors/metrics";
import { announceClock } from "@tutors/clock";
import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { createIdentityHandle } from "@tutors/identity-better-auth/server";
import { composeTime } from "./lib/compose.ts";

setAppName("tutors-time");
// The composition root for the server: the same wiring the browser gets, so both answer alike.
composeTime(publicEnv);
// From here on every stdout/stderr line of the running server is one JSON object: stray console
// output, crashes and Node warnings included. Not during `vite build`, which imports this module too.
if (!building) installProcessLogging();

export const init: ServerInit = async () => {
  logServiceStart({ version: APP_VERSION });
  announceClock(log);
};

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
};

/**
 * GitHub sign-in for the snippet dashboard (issue #155): it shows student-authored snippets, so it
 * has to know who is asking before it hands any over. Authorisation itself lives in
 * `lib/server/snippets.ts`; this only establishes identity, with the same adapter as the reader.
 * A GitHub OAuth App permits one callback URL, so this app needs its own OAuth App whose callback
 * is `<time-origin>/api/auth/callback/github`.
 */
const authHandle = createIdentityHandle({
  enabled: () => publicEnv.PUBLIC_ANON_MODE?.trim().toUpperCase() !== "TRUE" && !!env.PRIVATE_AUTH_SECRET?.trim(),
  secret: env.PRIVATE_AUTH_SECRET,
  githubId: env.PRIVATE_AUTH_GITHUB_ID,
  githubSecret: env.PRIVATE_AUTH_GITHUB_SECRET
});

export const handle = sequence(createRequestLogger(), metricsHandle, securityHeaders, authHandle);

export const handleError: HandleServerError = ({ kind, error, event }) => {
  if (kind !== "unknown") return;
  logRequestError({ error, event, status: 500, message: "Internal Error" });
  return {
    status: 500,
    message: "An unexpected error occurred"
  };
};
