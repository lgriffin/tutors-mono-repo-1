import type { LiveEvent, Service } from "@tutors/domain/live";
import type { LiveEventReporter } from "../ports/live-event-reporter.ts";

/**
 * A LiveEventReporter that keeps what it was told. Disabled (the anonymous reader's default) it
 * records nothing, like a reporter with no endpoint; enabled, a test reads the queue back.
 */
export class RecordingLiveEventReporter implements LiveEventReporter {
  readonly sid: string;
  readonly events: LiveEvent[] = [];
  flushes = 0;
  started = 0;
  uid: string | undefined;
  #open = false;

  constructor(
    readonly enabled = true,
    private readonly now: () => Date = () => new Date(),
    sid = "2026-01-05.recording"
  ) {
    this.sid = sid;
  }

  pending(): readonly LiveEvent[] {
    return this.events;
  }

  identify(uid: string | undefined): void {
    this.uid = uid;
  }

  #push(event: LiveEvent): void {
    if (this.enabled) this.events.push(event);
  }

  #ensureSession(course: string, ts: string): void {
    if (this.#open) return;
    this.#open = true;
    this.#push({ type: "session.started", ts, sid: this.sid, course, ...(this.uid ? { uid: this.uid } : {}) });
  }

  courseOpened(course: string): void {
    const ts = this.now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "course.opened", ts, sid: this.sid, course });
  }

  loViewed(course: string, lo: string, loType: string): void {
    const ts = this.now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "lo.viewed", ts, sid: this.sid, course, lo, loType });
  }

  serviceUsed(course: string, service: Service): void {
    const ts = this.now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "service.used", ts, sid: this.sid, course, service });
  }

  heartbeat(course: string, lo?: string): void {
    const ts = this.now().toISOString();
    this.#ensureSession(course, ts);
    this.#push({ type: "session.heartbeat", ts, sid: this.sid, course, ...(lo ? { lo } : {}) });
  }

  sessionEnded(course: string): void {
    if (!this.#open) return;
    this.#open = false;
    this.#push({ type: "session.ended", ts: this.now().toISOString(), sid: this.sid, course, durationSec: 0 });
  }

  async flush(): Promise<void> {
    this.flushes += 1;
  }

  flushBeacon(): void {
    this.flushes += 1;
  }

  start(): () => void {
    this.started += 1;
    return () => {
      this.started -= 1;
    };
  }
}
