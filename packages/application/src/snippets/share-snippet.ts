import type { Clock } from "../ports/clock.ts";
import type { CourseNotices, SnippetSharedNotice } from "../ports/course-notices.ts";
import type { NewSnippet, SharedSnippet, SnippetStore } from "../ports/snippet-store.ts";

/** A shared snippet is kept for 48 hours, never longer, and the learner cannot choose otherwise. */
export const SNIPPET_TTL_MS = 48 * 60 * 60 * 1000;
/** A learner may share at most this many snippets with one course in a rolling hour. */
export const SNIPPET_RATE_LIMIT = 3;
export const SNIPPET_RATE_WINDOW_MS = 60 * 60 * 1000;
/** The body of a snippet, in UTF-8 bytes. */
export const MAX_SNIPPET_BYTES = 400 * 1000;

/** What a learner fills in; the server adds who they are and when. */
export type SnippetInput = {
  courseId: string;
  filename: string;
  content: string;
  title?: string;
  loRoute?: string;
  loTitle?: string;
};

export type SnippetRefusal = "empty" | "too-large" | "rate-limited" | "failed";
export type ShareSnippetResult = { ok: true; id: string; expiresAt: string } | { ok: false; reason: SnippetRefusal };

export type ShareSnippetDeps = {
  store: SnippetStore;
  notices: CourseNotices;
  clock: Clock;
  /** Ids for the notice; the default is a UUID. */
  newId?: () => string;
};

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value.trim() : undefined);

/**
 * The learner's request, copied field by field so nothing else reaches the store.
 * @returns the input, or the reason it was refused
 */
export function parseSnippetInput(body: unknown): SnippetInput | string {
  if (!body || typeof body !== "object") return "body is not an object";
  const b = body as Record<string, unknown>;
  const courseId = text(b.courseId, 200);
  if (!courseId) return "courseId is required, at most 200 characters";
  const filename = text(b.filename, 200);
  if (!filename) return "filename is required, at most 200 characters";
  if (typeof b.content !== "string" || !b.content.trim()) return "content is required";
  const title = text(b.title ?? "", 500);
  const loRoute = text(b.loRoute ?? "", 500);
  const loTitle = text(b.loTitle ?? "", 500);
  if (title === undefined || loRoute === undefined || loTitle === undefined) return "title, loRoute and loTitle are strings of at most 500 characters";
  return { courseId, filename, content: b.content, title, loRoute, loTitle };
}

export function snippetBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function snippetSharedNotice(courseId: string, id: string, sentAt: number): SnippetSharedNotice {
  return { type: "gist-created", id, courseId, sentAt };
}

const uuid = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Keeps a learner's snippet for the course's educators and tells their dashboards. The expiry is
 * computed here, never taken from the learner; a learner over the hourly limit, or sharing an
 * empty or oversized body, is refused before anything is written. A notice that fails to post
 * does not undo the share: the snippet is there for the next dashboard load.
 */
export function shareSnippet({ store, notices, clock, newId = uuid }: ShareSnippetDeps) {
  return async (input: SnippetInput, learner: { login: string; name: string | null }): Promise<ShareSnippetResult> => {
    if (!input.content.trim()) return { ok: false, reason: "empty" };
    if (snippetBytes(input.content) > MAX_SNIPPET_BYTES) return { ok: false, reason: "too-large" };

    const now = clock.nowMs();
    const since = new Date(now - SNIPPET_RATE_WINDOW_MS).toISOString();
    const shared = await store.countSince(input.courseId, learner.login, since);
    if (shared !== null && shared >= SNIPPET_RATE_LIMIT) return { ok: false, reason: "rate-limited" };

    const expiresAt = new Date(now + SNIPPET_TTL_MS).toISOString();
    const snippet: NewSnippet = {
      courseId: input.courseId,
      learnerId: learner.login,
      learnerName: learner.name,
      filename: input.filename.trim() || "snippet.txt",
      content: input.content,
      title: input.title?.trim() || null,
      loRoute: input.loRoute?.trim() || null,
      loTitle: input.loTitle?.trim() || null,
      expiresAt
    };
    let id: string;
    try {
      id = await store.add(snippet);
    } catch {
      return { ok: false, reason: "failed" };
    }
    await notices.post(snippetSharedNotice(input.courseId, newId(), now)).catch(() => false);
    return { ok: true, id, expiresAt };
  };
}

/** The snippets a course's educators may read now: those not yet expired, newest first. */
export function activeSnippets({ store, clock }: { store: SnippetStore; clock: Clock }) {
  return (courseId: string): Promise<SharedSnippet[]> => store.active(courseId, clock.now().toISOString());
}
