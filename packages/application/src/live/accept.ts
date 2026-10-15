import { MAX_BATCH_SIZE, parseLiveEvents, type LiveEvent, type Rejection } from "@tutors/domain/live";
import type { LiveBus } from "../ports/live-bus.ts";

/** What became of a batch the reader posted. */
export interface AcceptedBatch {
  /** The events that passed validation and were published. */
  events: LiveEvent[];
  rejected: Rejection[];
  /** The batch limit, so a refusal can say what it was. */
  batchLimit: number;
}

/**
 * Accepts a batch of live events from a browser: validates every one, drops what cannot be
 * believed, and publishes the rest on the bus. The endpoint is anonymous and unauthenticated
 * by design (being counted costs no identity), so this validation is the only control.
 */
export function acceptLiveEvents(deps: { bus: LiveBus }) {
  return async (payload: unknown): Promise<AcceptedBatch> => {
    const { events, rejected } = parseLiveEvents(payload);
    if (events.length > 0) await deps.bus.publish(events);
    return { events, rejected, batchLimit: MAX_BATCH_SIZE };
  };
}
