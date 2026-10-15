import { ACTIVE_WINDOW_MS, SERVICE_WINDOW_MS, snapshotOf, type LiveEvent, type NowSnapshot, type Presence, type Touch } from "@tutors/domain/live";
import type { LivePresenceStore } from "../ports/live-presence-store.ts";

/**
 * The in-memory LivePresenceStore: what tests run against, and what the live app composes
 * with no Valkey behind it.
 *
 * Everything it holds is inside the presence window, so the memory it uses is
 * bounded by concurrent sessions rather than by uptime.
 */
export function inMemoryPresenceStore(): LivePresenceStore {
  const presences = new Map<string, Presence>();
  const touches: Touch[] = [];

  const prune = (at: number) => {
    for (const [sid, presence] of presences) {
      if (presence.at < at - ACTIVE_WINDOW_MS) presences.delete(sid);
    }
    const cutoff = at - SERVICE_WINDOW_MS;
    while (touches.length > 0 && touches[0].at < cutoff) touches.shift();
  };

  return {
    kind: "memory",

    async touch(event: LiveEvent): Promise<void> {
      const at = Date.parse(event.ts);
      if (Number.isNaN(at)) return;

      if (event.type === "session.ended") {
        presences.delete(event.sid);
      } else {
        const previous = presences.get(event.sid);
        const lo = event.type === "lo.viewed" ? event.lo : event.type === "session.heartbeat" ? (event.lo ?? previous?.lo) : previous?.lo;
        presences.set(event.sid, { sid: event.sid, course: event.course, at: Math.max(at, previous?.at ?? 0), ...(lo ? { lo } : {}) });
      }

      if (event.type === "service.used") touches.push({ service: event.service, sid: event.sid, at });
      prune(at);
    },

    async now(at: Date = new Date()): Promise<NowSnapshot> {
      prune(at.getTime());
      return snapshotOf([...presences.values()], touches, at);
    },

    async close(): Promise<void> {
      presences.clear();
      touches.length = 0;
    }
  };
}
