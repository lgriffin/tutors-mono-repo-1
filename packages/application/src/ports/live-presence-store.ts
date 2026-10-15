import type { LiveEvent, NowSnapshot } from "@tutors/domain/live";

/** The short-lived presence store behind the dashboard's "Now" layer: everything in it expires. */
export interface LivePresenceStore {
  readonly kind: string;
  /** Applies one event to the presence view, at full timestamp precision. */
  touch(event: LiveEvent): Promise<void>;
  /** Presence as of `at`, dropping sessions whose last event is older than the active window. */
  now(at?: Date): Promise<NowSnapshot>;
  close(): Promise<void>;
}
