/**
 * Realtime without Supabase (S3 of leaving Supabase): the reader's server publishes to Valkey
 * pub/sub, the reader's and Tutors Live's servers stream each topic to browsers over server-sent
 * events, and the browser's @tutors/realtime gateway subscribes to those streams. Picked by
 * PUBLIC_REALTIME=valkey; Supabase Realtime stays the default until S4. The only package that
 * imports `redis` for realtime, lazily, behind `connectValkey`.
 */
export { connectValkey, type PubSubClient, type PubSubPair } from "./client.ts";
export { CHANNEL_PREFIX, memoryRealtimeHub, realtimeHub, valkeyRealtimeHub, type HubListener, type HubMessage, type RealtimeHub } from "./hub.ts";
export { KEEPALIVE_MS, realtimeStream, type StreamOptions } from "./stream.ts";
export { PLAYGROUND_EVENTS, playgroundTopic, playgroundTopicOf, streamableTopic } from "./topics.ts";
export {
  BROWSER_MESSAGES_PER_SECOND,
  LO_EVENT,
  MAX_BROWSER_MESSAGE_BYTES,
  publishBrowserMessage,
  publishLiveActivity,
  publishNotice,
  topicRateLimiter,
  type BrowserPublishResponse,
  type ValkeyActivityResponse
} from "./server.ts";
export { REALTIME_PUBLISH_ROUTE, REALTIME_STREAM_ROUTE, sseRealtimeAdapter, type EventSourceLike, type SseAdapterOptions } from "./browser.ts";
export { valkeyPresence, type ValkeyPresenceOptions } from "./presence.ts";
export { COURSE_NOTICES_ROUTE, isCourseNotice, noticeEvent, noticeTopic, valkeyCourseNotices, type ValkeyCourseNoticesOptions } from "./notices.ts";
export { valkeyPlaygroundLive } from "./playground-live.ts";
export { valkeyBrowserRealtime, type ValkeyBrowserRealtime } from "./browser-realtime.ts";

/** Which broker PUBLIC_REALTIME names; anything but `valkey` is Supabase, so the dual release keeps Supabase until a deployment opts in. */
export function realtimeKindOf(env: { PUBLIC_REALTIME?: string }): "supabase" | "valkey" {
  return env.PUBLIC_REALTIME?.trim().toLowerCase() === "valkey" ? "valkey" : "supabase";
}
