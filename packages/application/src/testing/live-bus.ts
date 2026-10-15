import type { LiveEvent } from "@tutors/domain/live";
import type { LiveBus } from "../ports/live-bus.ts";

/**
 * The in-memory LiveBus: what tests run against, and what the live app composes when no broker
 * is configured. Delivery is in-process and nothing is durable; a restart loses whatever had
 * not been written to the warehouse.
 */
export function inMemoryLiveBus(): LiveBus {
  const handlers = new Set<(event: LiveEvent) => void | Promise<void>>();

  return {
    kind: "memory",

    async publish(events: LiveEvent[]): Promise<void> {
      for (const event of events) {
        for (const handler of [...handlers]) await handler(event);
      }
    },

    async subscribe(handler): Promise<() => Promise<void>> {
      handlers.add(handler);
      return async () => {
        handlers.delete(handler);
      };
    },

    async close(): Promise<void> {
      handlers.clear();
    }
  };
}
