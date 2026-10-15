import { MAX_BATCH_SIZE, currentSid, type LiveEvent, type Service, type SidStorage } from "@tutors/domain/live";
import type { LiveEventReporter } from "@tutors/application/ports";

/**
 * The browser-side reporter.
 *
 * Events are queued and posted in batches to the ingest endpoint, which is the
 * only thing that knows about the bus - a browser cannot speak NATS or Redis,
 * and it publishes nothing itself. With no endpoint configured the reporter is
 * a no-op, so a deployment that has not stood up the live pipeline behaves
 * exactly as it did before.
 */

/** The browser's localStorage, or null when there is no browser. */
export function browserStorage(): SidStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** How the reporter reaches the network and the clock; every part is injectable for tests. */
export interface HttpReporterOptions {
  /** Ingest endpoint, e.g. `https://live.tutors.dev/api/live/events`. Absent disables the emitter. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  /** Where the rotating session token lives. Defaults to localStorage. */
  storage?: SidStorage | null;
  now?: () => Date;
  /** Flush once this many events are queued. */
  batchSize?: number;
  /** Idle gap after which a session is considered over (definitions, section 2). */
  sessionIdleMs?: number;
  /** Best-effort flush on page hide. */
  sendBeacon?: (url: string, body: string) => boolean;
  /** How often the heartbeat beats while the page is visible. */
  heartbeatMs?: number;
  /** Called with the reason when a flush fails, so the app can log it. */
  onError?: (error: unknown) => void;
}

const THIRTY_MINUTES = 30 * 60 * 1000;

class QueueingReporter implements LiveEventReporter {
  readonly enabled: boolean;
  readonly sid: string;

  #queue: LiveEvent[] = [];
  #options: HttpReporterOptions & { batchSize: number; sessionIdleMs: number };
  #sessionStart: number | null = null;
  #lastActivity = 0;
  #inFlight: Promise<void> = Promise.resolve();
  /** The opaque identifier for a signed-in learner who opted in, once it has been hashed. */
  #uid: string | undefined;

  constructor(options: HttpReporterOptions) {
    this.#options = { ...options, batchSize: options.batchSize ?? 20, sessionIdleMs: options.sessionIdleMs ?? THIRTY_MINUTES };
    this.enabled = Boolean(options.endpoint);
    const storage = options.storage === undefined ? browserStorage() : options.storage;
    this.sid = currentSid(storage, this.#now());
  }

  #now(): Date {
    return this.#options.now ? this.#options.now() : new Date();
  }

  pending(): readonly LiveEvent[] {
    return this.#queue;
  }

  /**
   * Records (or withdraws) the identifier a signed-in learner opted in with. It
   * joins the next session rather than the one already open, which is the
   * conservative order to get it in; the learner's earlier events are purged
   * server-side on opt-out.
   */
  identify(uid: string | undefined): void {
    this.#uid = uid;
  }

  /** Queues an event and flushes once the batch is full. */
  #push(event: LiveEvent): void {
    if (!this.enabled) return;
    this.#queue.push(event);
    this.#lastActivity = Date.parse(event.ts);
    if (this.#queue.length >= Math.min(this.#options.batchSize, MAX_BATCH_SIZE)) void this.flush();
  }

  /**
   * Opens (or re-opens) the session before the event that needs it. A gap longer
   * than the idle window closes the old session first, so the durations the
   * warehouse stores match the definition of a session.
   */
  #ensureSession(course: string, ts: string): void {
    const at = Date.parse(ts);
    if (this.#sessionStart !== null && at - this.#lastActivity > this.#options.sessionIdleMs) {
      this.#end(course, this.#lastActivity);
    }
    if (this.#sessionStart === null) {
      this.#sessionStart = at;
      const identifier = this.#uid;
      this.#push({ type: "session.started", ts, sid: this.sid, course, ...(identifier ? { uid: identifier } : {}) });
    }
  }

  #end(course: string, at: number): void {
    if (this.#sessionStart === null) return;
    const started = this.#sessionStart;
    this.#sessionStart = null;
    const durationSec = Math.max(0, Math.round((at - started) / 1000));
    this.#push({ type: "session.ended", ts: new Date(Math.max(at, started)).toISOString(), sid: this.sid, course, durationSec });
  }

  courseOpened(course: string): void {
    if (!this.enabled) return;
    const ts = this.#now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "course.opened", ts, sid: this.sid, course });
  }

  loViewed(course: string, lo: string, loType: string): void {
    if (!this.enabled) return;
    const ts = this.#now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "lo.viewed", ts, sid: this.sid, course, lo, loType });
  }

  serviceUsed(course: string, service: Service): void {
    if (!this.enabled) return;
    const ts = this.#now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "service.used", ts, sid: this.sid, course, service });
  }

  heartbeat(course: string, lo?: string): void {
    if (!this.enabled) return;
    const ts = this.#now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "session.heartbeat", ts, sid: this.sid, course, ...(lo ? { lo } : {}) });
  }

  sessionEnded(course: string): void {
    if (!this.enabled) return;
    this.#end(course, this.#now().getTime());
  }

  #take(): LiveEvent[] {
    const batch = this.#queue.slice(0, MAX_BATCH_SIZE);
    this.#queue = this.#queue.slice(batch.length);
    return batch;
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.#queue.length === 0) return;
    const batch = this.#take();
    const endpoint = this.#options.endpoint as string;
    const post = this.#inFlight.then(async () => {
      const send = this.#options.fetch ?? globalThis.fetch;
      try {
        await send(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
          keepalive: true,
          credentials: "omit"
        });
      } catch (error) {
        // Telemetry must never break the page: the batch is dropped rather than
        // retried forever into an endpoint that is not answering.
        this.#options.onError?.(error);
      }
    });
    this.#inFlight = post;
    return post;
  }

  flushBeacon(): void {
    if (!this.enabled || this.#queue.length === 0) return;
    const endpoint = this.#options.endpoint as string;
    // A Blob typed application/json, not a bare string: a string beacon is sent
    // as text/plain, which SvelteKit's cross-site form check rejects when the
    // reader and the live app are on different origins.
    const beacon = this.#options.sendBeacon ?? ((url: string, body: string) => navigator.sendBeacon(url, new Blob([body], { type: "application/json" })));
    const batch = this.#take();
    try {
      if (!beacon(endpoint, JSON.stringify(batch))) this.#queue.unshift(...batch);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  /**
   * Registers the browser lifecycle the reporter needs: a heartbeat while the
   * page is visible, and a beacon flush when it goes away.
   * @returns a function that unregisters everything.
   */
  start(course: () => string | undefined, lo: () => string | undefined): () => void {
    if (!this.enabled || typeof document === "undefined") return () => {};
    const heartbeatMs = this.#options.heartbeatMs ?? 60_000;

    const beat = () => {
      const courseId = course();
      if (courseId && !document.hidden) this.heartbeat(courseId, lo());
      // The queue otherwise waits for a full batch, which a quiet reader never
      // reaches; the beat is also what bounds how stale presence can get.
      void this.flush();
    };
    const leave = () => {
      const courseId = course();
      if (courseId) this.sessionEnded(courseId);
      this.flushBeacon();
    };

    const timer = setInterval(beat, heartbeatMs);
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
    };
  }
}

/** Builds a reporter. With no `endpoint` every method is a no-op. */
export function httpLiveEventReporter(options: HttpReporterOptions = {}): LiveEventReporter {
  return new QueueingReporter(options);
}
