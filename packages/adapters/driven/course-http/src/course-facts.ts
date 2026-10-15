/**
 * The published facts about a course (its educators, privacy, title), read from its tutors.json:
 * the application's CourseFactsSource. The server asks only a course's own Netlify site or a host
 * named in `allowedHosts`, follows a redirect only to a public https host, and reports a host that
 * cannot answer as `unavailable` rather than as a course nobody teaches.
 */
import { courseFactsFrom } from "@tutors/domain/access";
import type { CourseFactsSource, CourseLookup } from "@tutors/application/ports";

export interface HttpCourseFactsOptions {
  fetch?: typeof fetch;
  /** Extra host names allowed to serve tutors.json, from PRIVATE_COURSE_HOSTS. */
  allowedHosts?: string[];
  /** How long to wait for a course's host. */
  timeoutMs?: number;
}

/** Where a course's tutors.json may be read from, or null when the id names no host the server may ask. */
export function courseJsonUrl(courseId: string, allowedHosts: string[] = []): string | null {
  const id = courseId.trim().toLowerCase();
  if (!id || id.includes("/") || id.includes(":") || id.includes("..")) return null;
  if (!id.includes(".")) return `https://${id}.netlify.app/tutors.json`;
  if (id.endsWith(".netlify.app") || allowedHosts.map((h) => h.toLowerCase()).includes(id)) {
    return `https://${id}/tutors.json`;
  }
  return null;
}

/** A redirect the server may follow: public https only, never an address literal or an internal name. */
export function redirectTarget(from: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const next = new URL(location, from);
    const host = next.hostname.toLowerCase();
    const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[");
    if (next.protocol !== "https:" || isIpLiteral || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || !host.includes(".")) return null;
    return next.toString();
  } catch {
    return null;
  }
}

export function httpCourseFacts(options: HttpCourseFactsOptions = {}): CourseFactsSource {
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async lookup(courseId: string): Promise<CourseLookup> {
      let url = courseJsonUrl(courseId, options.allowedHosts);
      if (!url) return { kind: "missing" };
      try {
        for (let hop = 0; hop <= 3; hop++) {
          const response = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
          if (response.status >= 300 && response.status < 400) {
            const next = redirectTarget(url, response.headers.get("location"));
            if (!next) return { kind: "missing" };
            url = next;
            continue;
          }
          if (response.status >= 500 || response.status === 429) return { kind: "unavailable" };
          if (!response.ok) return { kind: "missing" };
          return { kind: "found", facts: courseFactsFrom(courseId, await response.json()) };
        }
        return { kind: "missing" };
      } catch {
        return { kind: "unavailable" };
      }
    }
  };
}
