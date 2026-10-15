import log from "@tutors/logger";
import type { AnalyticsEvent, CourseVisitReport, LockChange, LockRemoval, MyStatus, MyStatusChange, PresenceReport, Profile, WhiteboardRoom, WhiteboardSave, WhiteboardScene } from "./contract.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One call to the data API, same-origin with the reader's session cookie. Null when the network
 * fails. A failed call is logged and its response returned, so callers such as analytics can stay
 * fire-and-forget. (Anonymous mode calls nothing: the composition root composes the in-memory
 * adapters instead of these.)
 */
async function send(fetchFn: FetchFn, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response | null> {
  try {
    const response = await fetchFn(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    // 401 is expected for a visitor who is not signed in, 503 on a server without the service key.
    if (!response.ok && response.status !== 401 && response.status !== 503) {
      log.warn("Data API call failed", { method, path, status: response.status });
    }
    return response;
  } catch (error) {
    log.warn("Data API unreachable", { method, path, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The data API, one function per route (contract.ts), over `fetchFn` (the platform's `fetch` by default). */
export function createDataApi(fetchFn: FetchFn = (input, init) => globalThis.fetch(input, init)) {
  /** The JSON body of a successful GET, or null. */
  async function getJson<T>(path: string): Promise<T | null> {
    const response = await send(fetchFn, "GET", path);
    if (!response?.ok) return null;
    return (await response.json()) as T;
  }
  return {
    recordAnalytics: (event: AnalyticsEvent) => send(fetchFn, "POST", "/api/analytics", event),
    getMyStatus: () => getJson<MyStatus>("/api/me"),
    saveMe: (change: MyStatusChange) => send(fetchFn, "PUT", "/api/me", change),
    changeMyStatus: (change: MyStatusChange) => send(fetchFn, "PATCH", "/api/me", change),
    getProfile: <Visit = Record<string, unknown>>() => getJson<Profile<Visit>>("/api/profile"),
    saveProfile: <Visit>(profile: Profile<Visit>) => send(fetchFn, "PUT", "/api/profile", profile),
    reportCourseVisit: (visit: CourseVisitReport) => send(fetchFn, "POST", "/api/courses/visit", visit),
    reportPresence: (report: PresenceReport) => send(fetchFn, "POST", "/api/presence", report),
    setLock: (change: LockChange) => send(fetchFn, "PUT", "/api/locks", change),
    removeLock: (removal: LockRemoval) => send(fetchFn, "DELETE", "/api/locks", removal),
    getWhiteboard: (room: WhiteboardRoom) =>
      getJson<{ scene: WhiteboardScene | null }>(`/api/whiteboard?${new URLSearchParams({ courseId: room.courseId, route: room.route, shared: String(room.shared) })}`),
    saveWhiteboard: (save: WhiteboardSave) => send(fetchFn, "PUT", "/api/whiteboard", save)
  };
}

export type DataApi = ReturnType<typeof createDataApi>;

/** The data API over the platform's `fetch`: what the reader's browser composition uses. */
export const dataApi: DataApi = createDataApi();
