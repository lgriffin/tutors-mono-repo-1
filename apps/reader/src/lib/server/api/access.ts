import { error } from "@sveltejs/kit";
import * as env from "$app/env/private";
import type { Permission } from "@tutors/domain/access";
import { AuthorizationUnavailableError, listFromEnv, type AuthorizationActor, type Resource } from "@tutors/application";
import { readerServer } from "./adapters.ts";

/** The reader's one authorization module (the application's, composed in lib/server/compose.ts). */
export function authorization() {
  return readerServer().authorization;
}

/** can(), for a route: 503 when the course's educators cannot be read (Rule 0073) rather than a silent no. */
export async function authorize(actor: AuthorizationActor | null, action: Permission, resource: Resource): Promise<boolean> {
  try {
    return await authorization().can(actor, action, resource);
  } catch (e) {
    if (e instanceof AuthorizationUnavailableError) error(503, "Could not read who teaches this course from its host; try again shortly");
    throw e;
  }
}

/** Origins (the time and live apps) allowed to read /api/time with the reader's session cookie. */
export function allowedOrigins(): string[] {
  return listFromEnv(env.PRIVATE_API_ALLOWED_ORIGINS);
}
