/**
 * The reader server's composed adapters, built from the environment the first time a data route
 * needs them and kept while the environment reads the same (it is static in a deployment; tests
 * change it between scenarios).
 */
import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { composeReaderServer, type ReaderServer, type ReaderServerEnv } from "../compose.ts";

let composed: { env: string; server: ReaderServer } | undefined;

export function readerServer(): ReaderServer {
  const current: ReaderServerEnv = {
    PUBLIC_ANON_MODE: publicEnv.PUBLIC_ANON_MODE,
    PRIVATE_DATABASE_URL: env.PRIVATE_DATABASE_URL,
    PRIVATE_COURSE_HOSTS: env.PRIVATE_COURSE_HOSTS,
    PRIVATE_TUTORS_ADMINS: env.PRIVATE_TUTORS_ADMINS,
    PRIVATE_VALKEY_URL: env.PRIVATE_VALKEY_URL
  };
  const key = JSON.stringify(current);
  if (composed?.env !== key) composed = { env: key, server: composeReaderServer(current) };
  return composed.server;
}
