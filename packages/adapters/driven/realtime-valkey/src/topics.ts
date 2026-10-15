import { topics, type Topic } from "@tutors/realtime";

/**
 * Which topics a browser may stream and which it may publish to. The stream answers only the
 * topics Tutors publishes (a course's activity, the platform's, a course's snippet pings and
 * broadcasts, an exercise's live share); the only messages a browser publishes itself are a live
 * share's state and a lecturer's "watching" announcement.
 */

/** The topic one exercise's live attach uses. */
export function playgroundTopic(courseId: string, loId: string): Topic {
  return `playground:${courseId}:${loId}` as Topic;
}

/** The events a browser may publish on a playground topic. */
export const PLAYGROUND_EVENTS = ["state", "watching"] as const;

/** As the reader's data API validates a course id. */
const COURSE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
/** A learning object id is a route; printable ASCII without spaces. */
const LO_ID = /^[\x21-\x7e]{1,400}$/;

function courseIdOf(value: string): string | null {
  return COURSE_ID.test(value) && !value.includes("..") ? value : null;
}

/** The topic of a playground share, or null for any other topic. */
export function playgroundTopicOf(raw: unknown): Topic | null {
  if (typeof raw !== "string" || !raw.startsWith("playground:")) return null;
  const rest = raw.slice("playground:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const courseId = courseIdOf(rest.slice(0, colon));
  const loId = rest.slice(colon + 1);
  return courseId && LO_ID.test(loId) ? playgroundTopic(courseId, loId) : null;
}

/** A topic Tutors publishes, or null: the stream subscribes to nothing else. */
export function streamableTopic(raw: unknown): Topic | null {
  if (typeof raw !== "string" || raw.length > 700) return null;
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
  const id = courseIdOf(raw);
  return id ? topics.courseActivity(id) : null;
}
