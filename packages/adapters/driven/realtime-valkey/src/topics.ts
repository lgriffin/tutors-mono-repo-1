import { topics, type Topic } from "@tutors/realtime";

/**
 * Which topics a browser may stream and which it may publish to. The stream answers only the
 * topics Tutors publishes (a course's activity, the platform's, a course's snippet pings and
 * broadcasts, an exercise's live share, a course's help queue, a shared whiteboard's room); the only messages a browser
 * publishes itself are a live share's state, a lecturer's "watching" announcement, and a shared whiteboard's scene
 * changes, cursors and presence.
 */

/** The topic one exercise's live attach uses. */
export function playgroundTopic(courseId: string, loId: string): Topic {
  return `playground:${courseId}:${loId}` as Topic;
}

/** The events a browser may publish on a playground topic. */
export const PLAYGROUND_EVENTS = ["state", "watching"] as const;

/** The events a browser may publish on a shared whiteboard's room. */
export const WHITEBOARD_EVENTS = ["scene-update", "cursor-update", "presence", "leave"] as const;

/**
 * A shared whiteboard's room topic, `wb:` + `whiteboardRoomId(courseId, route, null)` (`wb-<course>-<route>`, every
 * character of the route outside [A-Za-z0-9-] made a dash), or null for any other topic. A personal board has no room.
 */
export function whiteboardTopicOf(raw: unknown): Topic | null {
  return typeof raw === "string" && /^wb:wb-[A-Za-z0-9._-]{1,780}$/.test(raw) ? (raw as Topic) : null;
}

/** As the reader's data API validates a course id. */
const COURSE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
/** A learning object id is a route; printable ASCII without spaces, as long as the reader's data API allows. */
const LO_ID = /^[\x21-\x7e]{1,512}$/;
/** "playground:" + a course id + ":" + a learning object id. */
const MAX_TOPIC_LENGTH = 800;

/** A course id as the reader's data API accepts it, or null. */
export function courseIdOf(value: string): string | null {
  return COURSE_ID.test(value) && !value.includes("..") ? value : null;
}

/** A playground share's course and exercise, or null for any other topic. */
export function playgroundOf(raw: unknown): { topic: Topic; courseId: string; loId: string } | null {
  if (typeof raw !== "string" || raw.length > MAX_TOPIC_LENGTH || !raw.startsWith("playground:")) return null;
  const rest = raw.slice("playground:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const courseId = courseIdOf(rest.slice(0, colon));
  const loId = rest.slice(colon + 1);
  return courseId && LO_ID.test(loId) ? { topic: playgroundTopic(courseId, loId), courseId, loId } : null;
}

/** The topic of a playground share, or null for any other topic. */
export function playgroundTopicOf(raw: unknown): Topic | null {
  return playgroundOf(raw)?.topic ?? null;
}

/** A course's or the platform's activity topic, or null: all Tutors Live streams. */
export function activityTopicOf(raw: unknown): Topic | null {
  if (typeof raw !== "string") return null;
  if (raw === topics.platformActivity()) return topics.platformActivity();
  const id = courseIdOf(raw);
  return id ? topics.courseActivity(id) : null;
}

/** A topic Tutors publishes, or null: the stream subscribes to nothing else. */
export function streamableTopic(raw: unknown): Topic | null {
  if (typeof raw !== "string" || raw.length > MAX_TOPIC_LENGTH) return null;
  if (raw === topics.platformActivity()) return topics.platformActivity();
  if (raw.startsWith("snippets:")) {
    const id = courseIdOf(raw.slice("snippets:".length));
    return id ? topics.courseSnippets(id) : null;
  }
  if (raw.startsWith("broadcast:")) {
    const id = courseIdOf(raw.slice("broadcast:".length));
    return id ? topics.courseBroadcasts(id) : null;
  }
  if (raw.startsWith("playground:")) return playgroundTopicOf(raw);
  if (raw.startsWith("wb:")) return whiteboardTopicOf(raw);
  if (raw.startsWith("assistance:")) {
    const id = courseIdOf(raw.slice("assistance:".length));
    return id ? (`assistance:${id}` as Topic) : null;
  }
  return activityTopicOf(raw);
}
