/**
 * The educator check of the snippet feature (reader `POST /api/gists`, `POST /api/notices`, the
 * time app's snippets page). It deliberately stays apart from `createAuthorization`
 * (authorization.ts): that one is the data API's server module over `CourseFactsSource`, which
 * reads only allow-listed public hosts, caches with a stale fallback and answers roles and
 * permissions; this one resolves a course the way the browser does (`courseJsonUrl` from the
 * domain: localhost and self-hosted courses included) over the plain `CourseSource`, so the time
 * app can gate its dashboard without the reader's host allow-list, and answers why it refused.
 */
import { isEducatorOf, type CourseAccess, type Enrolment } from "@tutors/domain/access";
import type { CourseSource, FetchLike } from "../ports/course-source.ts";
import { courseJsonUrl } from "@tutors/domain/course";

export type EducatorCheck = { ok: true; login: string } | { ok: false; reason: "anonymous" | "not-educator" | "no-enrollment" };

export type CourseEducatorsDeps = {
  source: CourseSource;
  /** How long a course's educator list is remembered; a dashboard asks many times. */
  cacheMs?: number;
  nowMs?: () => number;
};

/**
 * Where a course id's tutors.json is served, as the CourseSource wants it: the protocol apart from
 * the host and path.
 */
export function courseLocationOf(courseId: string): { courseId: string; courseUrl: string; protocol: "https://" | "http://" } {
  const url = courseJsonUrl(courseId);
  const protocol = url.startsWith("http://") ? "http://" : "https://";
  return { courseId: courseId.trim(), courseUrl: url.slice(protocol.length, -"/tutors.json".length), protocol };
}

/**
 * A course's access rules (its auth level and enrollment) from its published tutors.json, cached
 * for `cacheMs`; null when the course cannot be read, which is cached as well.
 */
export function courseAccessOf({ source, cacheMs = 5 * 60 * 1000, nowMs = () => Date.now() }: CourseEducatorsDeps) {
  const cache = new Map<string, { access: CourseAccess | null; fetchedAt: number }>();
  return async (courseId: string, fetchFn?: FetchLike): Promise<CourseAccess | null> => {
    const cached = cache.get(courseId);
    if (cached && nowMs() - cached.fetchedAt < cacheMs) return cached.access;
    let access: CourseAccess | null;
    try {
      const course = JSON.parse(await source.load(courseLocationOf(courseId), fetchFn)) as { authLevel?: unknown; enrollment?: Enrolment } | null;
      access = { authLevel: typeof course?.authLevel === "number" ? course.authLevel : 0, enrollment: course?.enrollment ?? undefined };
    } catch {
      access = null;
    }
    cache.set(courseId, { access, fetchedAt: nowMs() });
    return access;
  };
}

/** Who teaches a course, from its access rules: the `educators` its enrollment lists; none when it cannot be read. */
export function educatorsFrom(accessOf: (courseId: string, fetchFn?: FetchLike) => Promise<CourseAccess | null>) {
  return async (courseId: string, fetchFn?: FetchLike): Promise<string[]> => {
    const educators = (await accessOf(courseId, fetchFn))?.enrollment?.educators;
    return Array.isArray(educators) ? educators : [];
  };
}

/**
 * Who teaches a course, read from the `educators` list its published tutors.json carries (the
 * course's enrollment.yaml): one source of truth, with nothing to sync at publish time. A course
 * that cannot be read, or has no enrollment, has no educators.
 */
export function courseEducators(deps: CourseEducatorsDeps) {
  return educatorsFrom(courseAccessOf(deps));
}

/**
 * Whether `login` may act as an educator of `courseId`. Fails closed: a course with no educators
 * admits nobody, so snippets never open up on a course that has not adopted enrollment.yaml.
 */
export function isCourseEducator(educatorsOf: (courseId: string, fetchFn?: FetchLike) => Promise<string[]>) {
  return async (courseId: string, login: string | null | undefined, fetchFn?: FetchLike): Promise<EducatorCheck> => {
    if (!login) return { ok: false, reason: "anonymous" };
    const educators = await educatorsOf(courseId, fetchFn);
    if (educators.length === 0) return { ok: false, reason: "no-enrollment" };
    if (!isEducatorOf(login, { educators })) return { ok: false, reason: "not-educator" };
    return { ok: true, login };
  };
}
