import { error, type RequestEvent } from "@sveltejs/kit";
import type { SessionUser } from "@tutors/store-supabase";
import { readerServer } from "./adapters.ts";
import type { ReaderServerData } from "../compose.ts";

export type { SessionUser };

type Locals = RequestEvent["locals"];

/** The verified identity of the request (locals.actor), or null for a visitor. */
export async function sessionUser(locals: Locals): Promise<SessionUser | null> {
  return locals.actor ?? null;
}

export async function requireUser(locals: Locals): Promise<SessionUser> {
  const user = await sessionUser(locals);
  if (!user) error(401, "Sign in to save your progress");
  return user;
}

/** The composed data adapters, or 503 when this server has no service client (Rule 0071 is kept by requireUser first). */
export function requireData(): ReaderServerData {
  const { data } = readerServer();
  if (!data) error(503, "Saving is not configured on this server");
  return data;
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) error(415, "Expected application/json");
  const text = await request.text();
  if (text.length > maxBytes) error(413, "Request body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    error(400, "Malformed JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) error(400, "Expected a JSON object");
  return body as Record<string, unknown>;
}

export function valid<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) error(400, message);
  return value;
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}
