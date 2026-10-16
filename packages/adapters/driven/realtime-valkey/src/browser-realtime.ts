import type { CourseNotices, PlaygroundLive, PresencePort } from "@tutors/application/ports";
import { createRealtimeGateway, type RealtimeGateway } from "@tutors/realtime";
import log from "@tutors/logger";
import { sseRealtimeAdapter, type SseAdapterOptions } from "./browser.ts";
import { valkeyCourseNotices } from "./notices.ts";
import { valkeyPlaygroundLive } from "./playground-live.ts";
import { valkeyPresence, type ValkeyPresenceOptions } from "./presence.ts";

export type ValkeyBrowserRealtime = {
  /** One per tab: the per-tab budget, the jittered rejoin and the counts cover every stream it opens. */
  gateway: RealtimeGateway;
  presence: PresencePort;
  playgroundLive: PlaygroundLive;
  notices: CourseNotices;
};

/**
 * A tab's realtime: one gateway over a Tutors server's streams, and the
 * three ports over that gateway. An app composes the ports it uses.
 */
export function valkeyBrowserRealtime(options: SseAdapterOptions & { presence?: ValkeyPresenceOptions } = {}): ValkeyBrowserRealtime {
  const gateway = createRealtimeGateway({
    adapter: sseRealtimeAdapter(options),
    onError: (failure, topic, error) => {
      if (failure === "send") log.error("Realtime send failed:", topic, error);
      else log.error("Leaving a realtime stream failed:", topic, error);
    }
  });
  return {
    gateway,
    presence: valkeyPresence(gateway, options.presence),
    playgroundLive: valkeyPlaygroundLive(gateway),
    notices: valkeyCourseNotices(gateway)
  };
}
