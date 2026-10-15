import log from "@tutors/logger";
import type {
  AnalyticsEvent,
  Catalogue,
  CourseVisitReport,
  ErrorReport,
  HelpPost,
  HelpQueue,
  LiveWatch,
  LiveWatchTier,
  LockChange,
  LockRemoval,
  Locks,
  MyHelpRequest,
  MyStatus,
  MyStatusChange,
  PlaygroundRemoval,
  PlaygroundSave,
  PlaygroundView,
  PresenceReport,
  Profile,
  Roster,
  ScormSave,
  ScormState,
  WhiteboardRoom,
  WhiteboardSave,
  WhiteboardScene
} from "./contract.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One call to the data API: same-origin with the reader's session cookie, or (from the catalogue,
 * live and time apps) to the reader at `base` without it. Null when the network fails. A failed call is logged and its response returned, so callers such as analytics can stay
 * fire-and-forget. (Anonymous mode calls nothing: the composition root composes the in-memory
 * adapters instead of these.)
 */
async function send(
  fetchFn: FetchFn,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  credentials: RequestCredentials = "same-origin"
): Promise<Response | null> {
  try {
    const response = await fetchFn(path, {
      method,
      credentials,
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

/** `/api/...?name=value` with the values that are set. */
function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
  return params.size ? `${path}?${params}` : path;
}

/**
 * The data API, one function per route (contract.ts), over `fetchFn` (the platform's `fetch` by
 * default). `base` is the reader's origin for an app other than the reader (its PUBLIC_READER_URL);
 * the reader itself calls its own routes, so it leaves `base` empty.
 */
export function createDataApi(fetchFn: FetchFn = (input, init) => globalThis.fetch(input, init), base = "") {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const origin = base.slice(0, end);
  const call: FetchFn = (path, init) => fetchFn(`${origin}${path}`, init);
  /** The JSON body of a successful GET, or null. */
  async function getJson<T>(path: string): Promise<T | null> {
    const response = await send(call, "GET", path);
    if (!response?.ok) return null;
    return (await response.json()) as T;
  }
  /** The JSON body of a successful write, or null. */
  async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T | null> {
    const response = await send(call, method, path, body);
    if (!response?.ok) return null;
    return (await response.json()) as T;
  }
  return {
    /** The reader's origin these calls go to; empty for the reader's own pages. */
    base: origin,
    recordAnalytics: (event: AnalyticsEvent) => send(call, "POST", "/api/analytics", event),
    getMyStatus: () => getJson<MyStatus>("/api/me"),
    saveMe: (change: MyStatusChange) => send(call, "PUT", "/api/me", change),
    changeMyStatus: (change: MyStatusChange) => send(call, "PATCH", "/api/me", change),
    getProfile: <Visit = Record<string, unknown>>() => getJson<Profile<Visit>>("/api/profile"),
    saveProfile: <Visit>(profile: Profile<Visit>) => send(call, "PUT", "/api/profile", profile),
    reportCourseVisit: (visit: CourseVisitReport) => send(call, "POST", "/api/courses/visit", visit),
    reportPresence: (report: PresenceReport) => send(call, "POST", "/api/presence", report),
    setLock: (change: LockChange) => send(call, "PUT", "/api/locks", change),
    removeLock: (removal: LockRemoval) => send(call, "DELETE", "/api/locks", removal),
    getWhiteboard: (room: WhiteboardRoom) =>
      getJson<{ scene: WhiteboardScene | null }>(`/api/whiteboard?${new URLSearchParams({ courseId: room.courseId, route: room.route, shared: String(room.shared) })}`),
    saveWhiteboard: (save: WhiteboardSave) => send(call, "PUT", "/api/whiteboard", save),
    getCatalogue: () => getJson<Catalogue>("/api/catalogue"),
    getRoster: (courseId?: string | null, since?: string | null) => getJson<Roster>(withQuery("/api/presence/roster", { courseId, since })),
    getLocks: (courseId: string) => getJson<Locks>(withQuery("/api/locks", { courseId })),
    getScorm: (courseId: string, loId: string) => getJson<ScormState>(withQuery("/api/scorm", { courseId, loId })),
    saveScorm: (save: ScormSave) => send(call, "PUT", "/api/scorm", save),
    getPlayground: (courseId: string, loId?: string | null, studentId?: string | null) => getJson<PlaygroundView>(withQuery("/api/playground", { courseId, loId, studentId })),
    savePlayground: (save: PlaygroundSave) => send(call, "PUT", "/api/playground", save),
    removePlayground: (removal: PlaygroundRemoval) => send(call, "DELETE", "/api/playground", removal),
    reportErrors: (report: ErrorReport) => send(call, "POST", "/api/errors", report),
    watchLive: (watch: LiveWatch) => sendJson<LiveWatchTier>("POST", "/api/live/watch", watch),
    // Help requests carry the session even from Tutors Live's origin: the reader decides from it who may act.
    postHelp: (post: HelpPost) => send(call, "POST", "/api/assistance", post, "include"),
    getMyHelpRequest: (courseId: string) => getJson<MyHelpRequest>(withQuery("/api/assistance/mine", { courseId })),
    getHelpQueue: async (courseId: string) => {
      const response = await send(call, "GET", withQuery("/api/assistance", { courseId }), undefined, "include");
      return response?.ok ? ((await response.json()) as HelpQueue) : null;
    }
  };
}

export type DataApi = ReturnType<typeof createDataApi>;

/** The data API over the platform's `fetch`: what the reader's browser composition uses. */
export const dataApi: DataApi = createDataApi();
