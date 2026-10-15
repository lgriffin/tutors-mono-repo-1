import type { LiveEvent } from "@tutors/domain/live";

/**
 * The bus carrying `tutors.live.*` between the ingest endpoint and whatever consumes it:
 * the ingest use case, the dashboard's stream. A browser never reaches it; the live app's
 * endpoint publishes on its behalf after validating the batch.
 */
export interface LiveBus {
  /** Name of the adapter, for `/healthz` and logs. */
  readonly kind: string;
  publish(events: LiveEvent[]): Promise<void>;
  /**
   * Delivers every event published from now on.
   * @returns a function that cancels the subscription.
   */
  subscribe(handler: (event: LiveEvent) => void | Promise<void>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
