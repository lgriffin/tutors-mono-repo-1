/**
 * Cross-origin answers for the data API. The catalogue, live and time apps call the reader at their
 * PUBLIC_READER_URL (Rule 0471): the public reads answer any origin without credentials, and the
 * reports (errors, Live watchers) and the time data only the origins in PRIVATE_API_ALLOWED_ORIGINS.
 */
import { json } from "@sveltejs/kit";
import { allowedOrigins } from "./access.ts";

export type CorsHeaders = Record<string, string>;

/** Public data (the catalogue, the shared presence roster, content locks): any origin may read it, never with cookies. */
export function publicReadHeaders(): CorsHeaders {
  return { "access-control-allow-origin": "*" };
}

/**
 * The headers for a request from `origin`: none for the reader's own pages, the CORS headers for an
 * allowed origin, null for any other (the caller answers 403 before touching the database).
 */
export function allowedOriginHeaders(request: Request, url: URL, credentials = false): CorsHeaders | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === url.origin) return {};
  if (!allowedOrigins().includes(origin)) return null;
  return { "access-control-allow-origin": origin, ...(credentials ? { "access-control-allow-credentials": "true" } : {}), vary: "Origin" };
}

/** A JSON answer with `headers`, never cached by a shared cache unless `cache` says so. */
export function answer(status: number, body: unknown, headers: CorsHeaders, cache = "private, no-store"): Response {
  return json(body, { status, headers: { ...headers, "cache-control": cache } });
}

/** The preflight for a JSON write from an allowed origin. */
export function preflight(request: Request, url: URL, methods: string): Response {
  const cors = allowedOriginHeaders(request, url);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors, "access-control-allow-methods": methods, "access-control-allow-headers": "content-type", "access-control-max-age": "600" }
  });
}
