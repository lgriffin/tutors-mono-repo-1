/**
 * The catalogue's composition root: the reader's data API (at PUBLIC_READER_URL) the catalogue is
 * read from, or nothing in anonymous mode. The catalogue holds no database key and creates no
 * database client (Rule 0471).
 */
import { createDataApi, type DataApi, type FetchFn } from "@tutors/data-api";

export type CatalogueEnv = { PUBLIC_ANON_MODE?: string; PUBLIC_READER_URL?: string };

/** The reader whose data API serves the catalogue; tutors.dev when unset (createDataApi drops trailing slashes). */
function readerUrl(env: CatalogueEnv): string {
  return env.PUBLIC_READER_URL?.trim() || "https://tutors.dev";
}

/** The data API over `fetchFn` (a load's own fetch on the server), or null in anonymous mode. */
export function composeCatalogue(env: CatalogueEnv, fetchFn?: FetchFn): DataApi | null {
  if (env.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE") return null;
  return createDataApi(fetchFn, readerUrl(env));
}
