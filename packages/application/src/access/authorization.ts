import { roleHasPermission, type CourseFacts, type Permission, type Role } from "@tutors/domain/access";
import type { Clock } from "../ports/clock.ts";
import type { CourseFactsSource, CourseLookup } from "../ports/course-facts.ts";

/** Someone signed in, as the verified identity names them. */
export interface Actor {
  login: string;
}

/** What an action is about. Courses are the only resource so far. */
export type Resource = { kind: "course"; courseId: string };

/**
 * The course's host could not be read (network error, timeout, 5xx, a broken tutors.json) and the
 * reader holds no copy young enough to use. Routes answer 503: "not an educator" would be a lie.
 */
export class AuthorizationUnavailableError extends Error {
  constructor(readonly courseId: string) {
    super(`Could not read the educators of ${courseId} from its host`);
    this.name = "AuthorizationUnavailableError";
  }
}

export interface AuthorizationDeps {
  /** Where a course's facts come from. */
  courseFacts: CourseFactsSource;
  clock: Clock;
  /** Logins treated as educators of every course (PRIVATE_TUTORS_ADMINS). */
  admins?: string[];
  /** How long a course read is trusted without asking its host again. */
  ttlMs?: number;
  /** How old a copy may be and still decide while the host is unreachable. */
  staleMs?: number;
}

/**
 * The one authorization module of the server: who may do what, decided on the server.
 *
 *   can(actor, action, resource)   the one question routes ask
 *   course(courseId)               the published facts about a course (title, educators, privacy)
 *
 * A login's role in a course comes from the course's enrollment.yaml (`educators`), read through
 * the CourseFactsSource, or from the admin list; what a role may do comes from the domain's
 * permission table, the same one the browser uses. A course read is cached for `ttlMs` (5 minutes);
 * while its host is unreachable the last copy read within `staleMs` (an hour) is used instead (Rule
 * 0074), and without one the decision is AuthorizationUnavailableError (Rule 0073), never a silent "no".
 */
export function createAuthorization({ courseFacts, clock, admins = [], ttlMs = 5 * 60_000, staleMs = 60 * 60_000 }: AuthorizationDeps) {
  const adminSet = new Set(admins);
  const fresh = new Map<string, { at: number; lookup: Promise<CourseLookup> }>();
  const lastGood = new Map<string, { at: number; facts: CourseFacts }>();

  function lookup(courseId: string): Promise<CourseLookup> {
    const hit = fresh.get(courseId);
    if (hit && clock.nowMs() - hit.at < ttlMs) return hit.lookup;
    const at = clock.nowMs();
    const pending = courseFacts.lookup(courseId).then((result) => {
      if (result.kind === "found") lastGood.set(courseId, { at, facts: result.facts });
      // Only a found course is worth caching; a missing or unreachable one is asked again next time.
      else fresh.delete(courseId);
      return result;
    });
    fresh.set(courseId, { at, lookup: pending });
    if (fresh.size > 2000) fresh.delete(fresh.keys().next().value!);
    if (lastGood.size > 2000) lastGood.delete(lastGood.keys().next().value!);
    return pending;
  }

  /** The course's published facts; null when its host has no such course. Throws AuthorizationUnavailableError. */
  async function course(courseId: string): Promise<CourseFacts | null> {
    const result = await lookup(courseId);
    if (result.kind === "found") return result.facts;
    if (result.kind === "missing") return null;
    const stale = lastGood.get(courseId);
    if (stale && clock.nowMs() - stale.at < staleMs) return stale.facts;
    throw new AuthorizationUnavailableError(courseId);
  }

  /** The actor's role in the resource's course. */
  async function roleIn(actor: Actor | null, resource: Resource): Promise<Role> {
    if (!actor?.login) return "student";
    if (adminSet.has(actor.login)) return "educator";
    const facts = await course(resource.courseId);
    return facts?.educators.includes(actor.login) ? "educator" : "student";
  }

  /** Whether the actor may perform the action on the resource. Throws AuthorizationUnavailableError. */
  async function can(actor: Actor | null, action: Permission, resource: Resource): Promise<boolean> {
    if (!actor?.login) return false;
    return roleHasPermission(await roleIn(actor, resource), action);
  }

  return { can, course };
}

export type Authorization = ReturnType<typeof createAuthorization>;

/** A comma- or space-separated list from the environment, as a list of names. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
