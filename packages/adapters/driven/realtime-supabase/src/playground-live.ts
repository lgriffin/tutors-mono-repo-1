import type { RealtimeGateway, Topic } from "@tutors/realtime";
import type { PlaygroundLive, PlaygroundLiveState } from "@tutors/application/ports";
import log from "@tutors/logger";

/**
 * Live attach over Supabase Realtime: the application's PlaygroundLive. One broadcast topic per
 * exercise, nothing stored, nothing retained; a student who is not sharing sends nothing at all.
 *
 * TODO(budget): this is the one place a browser still publishes over Realtime (through the gateway,
 * so the per-tab budget, jittered rejoin and counts apply). A student sharing sends at most one state
 * every 1.5 s to the lecturers watching that exercise; a lecturer's "watching" announcement is one
 * message. Routing it through the reader's server and the day's Live budget (receiveLiveActivity,
 * realtime_claim_live_publish) needs a budget rule per playground topic that does not exist yet.
 */

const STATE_EVENT = "state";
const WATCHING_EVENT = "watching";
/** How often a watcher checks whether its link is live yet, to announce itself once. */
const ANNOUNCE_POLL_MS = 250;

/** The topic one exercise's live attach uses. */
export function playgroundTopic(courseId: string, loId: string): Topic {
  return `playground:${courseId}:${loId}` as Topic;
}

export function supabasePlaygroundLive(gateway: RealtimeGateway): PlaygroundLive {
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
      // The announcement goes out once the link is live. It carries no authority: a student who is
      // not sharing stays silent through it.
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

