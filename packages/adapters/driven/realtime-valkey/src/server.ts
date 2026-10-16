/**
 * What the reader's server publishes, on Valkey: Tutors Live's activity (POST /api/live/activity),
 * course notices (POST /api/gists, POST /api/notices) and the messages a browser hands it to
 * publish (POST /api/realtime/publish). There is no daily budget: publishing to a Valkey channel
 * nobody streams costs nothing, so every learning event goes to its course's and the platform's
 * activity topics, and the Live tabs that stream them hear it.
 */
import { parseLiveActivity } from "@tutors/domain/presence";
import type { CourseNotice } from "@tutors/application/ports";
import { topics } from "@tutors/realtime";
import log from "@tutors/logger";
import type { RealtimeHub } from "./hub.ts";
import { noticeEvent, noticeTopic } from "./notices.ts";
import { PLAYGROUND_EVENTS, WHITEBOARD_EVENTS, playgroundOf, whiteboardTopicOf } from "./topics.ts";

export const LO_EVENT = "lo-event";

/** The answer to POST /api/live/activity: the same shape as on Supabase, always the normal tier. */
export type ValkeyActivityResponse = { status: number; body?: { tier: "normal"; topics: string[] } | { message: string } };

/**
 * Publishes one learning event to its course's and the platform's activity topics.
 * 400 for a malformed body; 204 with no hub (anonymous mode); otherwise 202 with the topics it was
 * published to (none when Valkey failed, which is logged).
 */
export async function publishLiveActivity(raw: string, hub: RealtimeHub | null): Promise<ValkeyActivityResponse> {
  const record = parseLiveActivity(raw);
  if (typeof record === "string") return { status: 400, body: { message: record } };
  if (!hub) return { status: 204 };
  const targets = [topics.courseActivity(record.courseId), topics.platformActivity()];
  const results = await Promise.allSettled(targets.map((topic) => hub.publish(topic, { event: LO_EVENT, payload: record })));
  const published: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") published.push(targets[i]);
    else log.error("Live activity publish failed:", targets[i], result.reason);
  });
  return { status: 202, body: { tier: "normal", topics: published } };
}

/** Publishes one course notice to its topic; false with no hub, no course, or when Valkey failed. */
export async function publishNotice(hub: RealtimeHub | null, notice: CourseNotice): Promise<boolean> {
  if (!hub || !notice.courseId) return false;
  try {
    await hub.publish(noticeTopic(notice.courseId, notice.type), { event: noticeEvent(notice.type), payload: notice });
    return true;
  } catch (error) {
    log.error("Publishing a course notice failed:", notice.type, notice.courseId, error);
    return false;
  }
}

/** A playground state carries the student's files; anything larger than this is refused. */
export const MAX_BROWSER_MESSAGE_BYTES = 256 * 1024;
/** Per sender on one topic, across every tab of theirs on this server: a share sends one state every 1.5 s. */
export const BROWSER_MESSAGES_PER_SECOND = 10;

export type BrowserPublishResponse = { status: 202 | 400 | 403 | 413 | 429 | 502; message?: string };

/**
 * A limiter over one-second windows per key (a sender on a topic), shared by every request a
 * server answers. The gateway already holds each tab to its budget; this holds one sender to one
 * however many tabs they open, without a class sharing one exercise crowding each other out.
 */
export function topicRateLimiter(perSecond = BROWSER_MESSAGES_PER_SECOND, now: () => number = Date.now): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>();
  return (topic) => {
    const at = now();
    const current = windows.get(topic);
    if (!current || at - current.start >= 1000) {
      if (windows.size > 10_000) windows.clear();
      windows.set(topic, { start: at, count: 1 });
      return true;
    }
    if (current.count >= perSecond) return false;
    current.count++;
    return true;
  };
}

/** Who posted a browser message: their signed-in login, and whether they teach a course. */
export type BrowserSender = { login: string; isEducator: (courseId: string) => Promise<boolean> };

/**
 * A signed-in browser's message to publish (POST /api/realtime/publish): on a playground topic, only
 * a live share's `state`, sent as the student it names, or a `watching` announcement from an
 * educator of the course; on a shared whiteboard's room, its scene changes, and its cursors,
 * presence and leaving sent as the person they name. Anything else is refused before Valkey sees it.
 */
export async function publishBrowserMessage(raw: string, hub: RealtimeHub, allow: (key: string) => boolean, sender: BrowserSender): Promise<BrowserPublishResponse> {
  if (new TextEncoder().encode(raw).length > MAX_BROWSER_MESSAGE_BYTES) return { status: 413, message: "body is larger than 256 KB" };
  let body: { topic?: unknown; event?: unknown; payload?: unknown; from?: unknown } | null;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, message: "body is not JSON" };
  }
  if (!body || typeof body !== "object") return { status: 400, message: "body is not an object" };
  const whiteboard = whiteboardTopicOf(body.topic);
  if (whiteboard) return publishWhiteboard(whiteboard, body, hub, allow, sender);
  const playground = playgroundOf(body.topic);
  if (!playground) return { status: 403, message: "a browser publishes only to a playground topic or a shared whiteboard's room" };
  const { topic, courseId } = playground;
  if (typeof body.event !== "string" || !(PLAYGROUND_EVENTS as readonly string[]).includes(body.event)) {
    return { status: 400, message: `event is one of ${PLAYGROUND_EVENTS.join(", ")}` };
  }
  if (body.event === "state" && (body.payload as { studentId?: unknown } | null)?.studentId !== sender.login) {
    return { status: 403, message: "a student shares only their own work" };
  }
  if (body.event === "watching" && !(await sender.isEducator(courseId))) {
    return { status: 403, message: "only an educator of the course watches a share" };
  }
  if (!allow(`${topic}|${sender.login}`)) return { status: 429, message: "too many messages on this topic" };
  return publishAs(hub, topic, body);
}

type BrowserMessage = { event?: unknown; payload?: unknown; from?: unknown };

/** The tab a message came from, so the tab can ignore its own: what Supabase's `broadcast: { self: false }` did. */
async function publishAs(hub: RealtimeHub, topic: string, body: BrowserMessage): Promise<BrowserPublishResponse> {
  const from = typeof body.from === "string" && body.from.length <= 64 ? body.from : undefined;
  try {
    await hub.publish(topic, { event: body.event as string, payload: body.payload ?? {}, ...(from ? { from } : {}) });
    return { status: 202 };
  } catch (error) {
    log.error("Publishing a browser's realtime message failed:", topic, error);
    return { status: 502, message: "the message was not published" };
  }
}

/**
 * A shared whiteboard's room (Rule 0573). Anyone signed in may draw on a shared board, as anyone
 * signed in may save it (PUT /api/whiteboard); a cursor, a presence or a leaving names its sender.
 * Each event has its own allowance, so a room's cursors (up to ten a second) never crowd out its scene.
 */
function publishWhiteboard(
  topic: string,
  body: BrowserMessage,
  hub: RealtimeHub,
  allow: (key: string) => boolean,
  sender: BrowserSender
): Promise<BrowserPublishResponse> | BrowserPublishResponse {
  if (typeof body.event !== "string" || !(WHITEBOARD_EVENTS as readonly string[]).includes(body.event)) {
    return { status: 400, message: `event is one of ${WHITEBOARD_EVENTS.join(", ")}` };
  }
  if (body.event !== "scene-update" && (body.payload as { userId?: unknown } | null)?.userId !== sender.login) {
    return { status: 403, message: "a cursor or presence names its own sender" };
  }
  if (!allow(`${topic}|${sender.login}|${body.event}`)) return { status: 429, message: "too many messages on this topic" };
  return publishAs(hub, topic, body);
}
