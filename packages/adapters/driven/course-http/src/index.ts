/**
 * Reads a published course's tutors.json over HTTP: the application's CourseSource port, and the
 * server's CourseFactsSource (course-facts.ts). Also the browser's side of the SnippetStore port:
 * a shared snippet goes to the reader's server over HTTP.
 */
import {
  CourseNotFoundError,
  CourseUnreachableError,
  type CourseLocation,
  type CourseSource,
  type FetchLike,
  type NewSnippet,
  type SharedSnippet,
  type SnippetStore
} from "@tutors/application/ports";
import log, { serializeError } from "@tutors/logger";

/**
 * One fixed message per failure, with what varies in fields: log collectors (and the release
 * harness) group and diff lines by message, so the course and URL must not be baked into it.
 * `error` and `stack` are always present so the line's key set does not depend on the cause.
 */
function logCourseFetchFailure(courseId: string, courseUrl: string, cause?: unknown): void {
  log.error("Error fetching course", {
    courseId,
    url: `https://${courseUrl}/tutors.json`,
    ...(cause === undefined ? { error: null, stack: null } : serializeError(cause))
  });
}

/** `fetchFn` defaults to the platform's; a SvelteKit load passes its own so server reads carry the request. */
export function httpCourseSource(fetchFn: FetchLike = (url) => globalThis.fetch(url)): CourseSource {
  return {
    async load(location: CourseLocation, fetchOverride?: FetchLike): Promise<string> {
      const { courseId, courseUrl, protocol } = location;
      const response = await (fetchOverride ?? fetchFn)(`${protocol}${courseUrl}/tutors.json`).catch((cause: unknown) => {
        logCourseFetchFailure(courseId, courseUrl, cause);
        // A browser reports a host that does not exist, and a 404 sent without CORS headers, as a
        // TypeError with no status: the same TypeError as being offline.
        if (cause instanceof TypeError) throw new CourseUnreachableError(courseId, courseUrl, cause);
        throw cause;
      });
      if (response.status === 404) {
        logCourseFetchFailure(courseId, courseUrl);
        throw new CourseNotFoundError(courseId, courseUrl);
      }
      if (!response.ok) {
        const failure = new Error(`Fetch failed with status ${response.status}`);
        logCourseFetchFailure(courseId, courseUrl, failure);
        throw failure;
      }
      return response.text();
    }
  };
}

/** The reader's server route that keeps a learner's snippet for the course's educators. */
export const SNIPPETS_ROUTE = "/api/gists";

/** What the reader's route answers when it refuses a snippet; the message is for the learner. */
export class SnippetRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SnippetRefusedError";
  }
}

/**
 * The browser's SnippetStore: it hands the snippet to the reader's own server (which writes the
 * row with its service key and tells the educators) and reads nothing. The dashboard that reads
 * snippets runs on the server with the Supabase store, so `active` and `countSince` have no
 * caller here and answer "nothing" and "unknown".
 */
export function httpSnippetStore(fetchFn: typeof fetch = (...args) => globalThis.fetch(...args)): SnippetStore {
  return {
    async add(snippet: NewSnippet): Promise<string> {
      const response = await fetchFn(SNIPPETS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId: snippet.courseId,
          filename: snippet.filename,
          content: snippet.content,
          title: snippet.title ?? "",
          loRoute: snippet.loRoute ?? "",
          loTitle: snippet.loTitle ?? ""
        })
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok || !body.id) throw new SnippetRefusedError(response.status, body.message ?? "Could not share the snippet");
      return body.id;
    },
    async active(): Promise<SharedSnippet[]> {
      return [];
    },
    async countSince(): Promise<number | null> {
      return null;
    }
  };
}

export { httpCourseFacts, courseJsonUrl, redirectTarget, type HttpCourseFactsOptions } from "./course-facts.ts";
