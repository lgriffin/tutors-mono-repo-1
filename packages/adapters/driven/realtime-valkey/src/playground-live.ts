import type { RealtimeGateway } from "@tutors/realtime";
import type { PlaygroundLive, PlaygroundLiveState } from "@tutors/application/ports";
import log from "@tutors/logger";
import { playgroundTopic } from "./topics.ts";

/**
 * Live attach on Valkey: the application's PlaygroundLive, as realtime-supabase has it (one topic per
 * exercise, nothing stored, a student who is not sharing sends nothing; S4 deletes that copy). A
 * send goes through the gateway, so the per-tab budget, jittered rejoin and counts apply, and its
 * broker adapter posts it to the reader's server (POST /api/realtime/publish), which publishes only
 * these two events and only on playground topics.
 */

const STATE_EVENT = "state";
const WATCHING_EVENT = "watching";
/** How often a watcher checks whether its link is live yet, to announce itself once. */
const ANNOUNCE_POLL_MS = 250;

export function valkeyPlaygroundLive(gateway: RealtimeGateway): PlaygroundLive {
  return {
    share(courseId, loId, onWatcher) {
      const subscription = gateway.subscribe(playgroundTopic(courseId, loId), {
        events: [WATCHING_EVENT],
        onMessage: () => onWatcher()
      });
      let active = true;
      return {
        send: (state: PlaygroundLiveState) => {
          if (!active) return;
          if (!subscription.send(STATE_EVENT, state)) log.debug("playground live state not sent (link not live or budget spent)");
        },
        stop: () => {
          if (!active) return;
          active = false;
          void subscription.close();
        }
      };
    },

    watch(courseId, loId, onState) {
      const subscription = gateway.subscribe(playgroundTopic(courseId, loId), {
        events: [STATE_EVENT],
        onMessage: (_event, payload) => {
          const state = payload as PlaygroundLiveState | undefined;
          if (state?.studentId) onState(state);
        }
      });
      let active = true;
      const announce = setInterval(() => {
        const state = subscription.state();
        if (state === "live") subscription.send(WATCHING_EVENT, {});
        if (state === "live" || state === "closed") clearInterval(announce);
      }, ANNOUNCE_POLL_MS);
      return () => {
        if (!active) return;
        active = false;
        clearInterval(announce);
        void subscription.close();
      };
    }
  };
}
