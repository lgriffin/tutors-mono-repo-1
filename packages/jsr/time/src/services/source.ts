/**
 * Where Tutors Time's rows come from: the reader's data API (GET /api/time/:courseId, Rules 0069,
 * 0070), so neither the Time app nor the reader's time page reads a table (Rule 0471).
 */
import type { TutorsConnectCourse, TutorsConnectUser, TutorsTimeRows } from "@tutors/domain/learning";

export type { TutorsTimeRows };

export interface TutorsTimeSource {
  courseRows(courseId: string, startDate?: string | null, endDate?: string | null): Promise<TutorsTimeRows>;
  courseRecord(courseId: string, startDate?: string | null, endDate?: string | null): Promise<Pick<TutorsConnectCourse, "course_id" | "course_record"> | null>;
  user(studentId: string, courseId?: string, startDate?: string | null, endDate?: string | null): Promise<Omit<TutorsConnectUser, "email"> | null>;
}

export class TutorsTimeSourceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TutorsTimeSourceError";
  }
}

export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

export function readerTimeSource(readerUrl: string, fetchFn: typeof fetch = (...args) => fetch(...args)): TutorsTimeSource {
  const base = withoutTrailingSlashes(readerUrl);
  const cache = new Map<string, { at: number; rows: Promise<TutorsTimeRows> }>();

  async function load(courseId: string, startDate?: string | null, endDate?: string | null): Promise<TutorsTimeRows> {
    const params = new URLSearchParams();
    if (startDate) params.set("start", startDate);
    if (endDate) params.set("end", endDate);
    const query = params.size ? `?${params}` : "";
    const response = await fetchFn(`${base}/api/time/${encodeURIComponent(courseId)}${query}`, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw new TutorsTimeSourceError(`The reader answered ${response.status} for the time data of ${courseId}`, response.status);
    return (await response.json()) as TutorsTimeRows;
  }

  function courseRows(courseId: string, startDate?: string | null, endDate?: string | null): Promise<TutorsTimeRows> {
    const key = JSON.stringify([courseId, startDate || null, endDate || null]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.rows;
    const rows = load(courseId, startDate, endDate);
    cache.set(key, { at: Date.now(), rows });
    rows.catch(() => cache.delete(key));
    return rows;
  }

  return {
    courseRows,
    async courseRecord(courseId, startDate, endDate) {
      return (await courseRows(courseId, startDate, endDate)).course;
    },
    async user(studentId, courseId, startDate, endDate) {
      if (!courseId) return null;
      return (await courseRows(courseId, startDate, endDate)).users.find((u) => u.github_id === studentId) ?? null;
    }
  };
}

let current: TutorsTimeSource | null = null;
const listeners = new Set<() => void>();

export function setTutorsTimeSource(source: TutorsTimeSource): void {
  current = source;
  for (const listener of listeners) listener();
}

/** The source set by the app; until one is set, the reader's data API on the page's own origin. */
export function getTutorsTimeSource(): TutorsTimeSource {
  current ??= readerTimeSource("");
  return current;
}

export function onTutorsTimeSourceChange(listener: () => void): void {
  listeners.add(listener);
}
