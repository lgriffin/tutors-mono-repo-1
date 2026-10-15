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
    PUBLIC_SUPABASE_URL: publicEnv.PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_ANON_KEY: publicEnv.PUBLIC_SUPABASE_ANON_KEY,
    PRIVATE_SUPABASE_SERVICE_ROLE_KEY: env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY,
    DATA_STORE: env.DATA_STORE,
    PRIVATE_DATABASE_URL: env.PRIVATE_DATABASE_URL,
    PRIVATE_COURSE_HOSTS: env.PRIVATE_COURSE_HOSTS,
    PRIVATE_TUTORS_ADMINS: env.PRIVATE_TUTORS_ADMINS,
    PUBLIC_REALTIME: publicEnv.PUBLIC_REALTIME,
    PRIVATE_VALKEY_URL: env.PRIVATE_VALKEY_URL
  };
  const key = JSON.stringify(current);
  if (composed?.env !== key) composed = { env: key, server: composeReaderServer(current) };
  return composed.server;
}
