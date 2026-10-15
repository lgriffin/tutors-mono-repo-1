import { isEducatorOf, type Enrolment } from "@tutors/domain/access";
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
 * Who teaches a course, read from the `educators` list its published tutors.json carries (the
 * course's enrollment.yaml): one source of truth, with nothing to sync at publish time. A course
 * that cannot be read, or has no enrollment, has no educators.
 */
export function courseEducators({ source, cacheMs = 5 * 60 * 1000, nowMs = () => Date.now() }: CourseEducatorsDeps) {
  const cache = new Map<string, { educators: string[]; fetchedAt: number }>();
  return async (courseId: string, fetchFn?: FetchLike): Promise<string[]> => {
    const cached = cache.get(courseId);
    if (cached && nowMs() - cached.fetchedAt < cacheMs) return cached.educators;
    let educators: string[] = [];
    try {
      const course = JSON.parse(await source.load(courseLocationOf(courseId), fetchFn)) as { enrollment?: Enrolment };
      educators = Array.isArray(course?.enrollment?.educators) ? course.enrollment.educators : [];
    } catch {
      educators = [];
    }
    cache.set(courseId, { educators, fetchedAt: nowMs() });
    return educators;
  };
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
