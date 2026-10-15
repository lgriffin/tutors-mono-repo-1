import type { LiveEvent, Service } from "@tutors/domain/live";

/**
 * How the reader tells Tutors Live what a session is doing. Events carry the rotating session
 * token and a course, never a login; an opaque identifier joins the next session only once a
 * signed-in learner has opted in. A reporter that is not configured is a no-op throughout.
 */
export interface LiveEventReporter {
  /** False when no endpoint is configured: every method is then a no-op. */
  readonly enabled: boolean;
  /** The rotating token this browser is using today. */
  readonly sid: string;
  /** Events waiting to be posted. Exposed for tests and the dev overlay. */
  pending(): readonly LiveEvent[];
  /** The hashed identifier to stamp on the next `session.started`; undefined withdraws it. */
  identify(uid: string | undefined): void;
  courseOpened(course: string): void;
  loViewed(course: string, lo: string, loType: string): void;
  serviceUsed(course: string, service: Service): void;
  heartbeat(course: string, lo?: string): void;
  sessionEnded(course: string): void;
  /** Posts everything queued. Resolves even when the post fails. */
  flush(): Promise<void>;
  /** Posts everything queued in a way that survives the page going away. */
  flushBeacon(): void;
  /**
   * Starts the heartbeat while the page is visible and the flush when it goes away.
   * @returns a function that stops both.
   */
  start(course: () => string | undefined, lo: () => string | undefined): () => void;
}
