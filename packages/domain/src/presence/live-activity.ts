import type { PresenceEvent } from "./events.ts";

/**
 * A learning event as a browser reports it to Tutors Live (the reader's POST /api/live/activity),
 * checked field by field so nothing else reaches a broadcast. Both realtime adapters publish only
 * what this returns.
 */

export const MAX_LIVE_ACTIVITY_BYTES = 4096;

/** The body's size in UTF-8 bytes, as TextEncoder counts it (a lone surrogate is three), without needing it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const MAX_ID = 200;
const MAX_USER_ID = 100;
const MAX_TEXT = 1000;
const MAX_ICON_KEYS = 8;

function text(value: unknown, max: number, required = false): string | undefined | false {
  if (value === undefined || value === null) return required ? false : undefined;
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) return false;
  return value;
}

/**
 * The presence event the browser built, copied field by field so nothing else reaches a broadcast.
 * @returns the record, or a reason it was refused
 */
export function parseLiveActivity(raw: string): PresenceEvent | string {
  if (utf8Length(raw) > MAX_LIVE_ACTIVITY_BYTES) return "body is larger than 4 KB";
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "body is not JSON";
  }
  if (!body || typeof body !== "object") return "body is not an object";
  const b = body as Record<string, unknown>;
  const u = (b.user && typeof b.user === "object" ? b.user : {}) as Record<string, unknown>;

  const courseId = text(b.courseId, MAX_ID, true);
  const userId = text(u.id, MAX_USER_ID, true);
  if (!courseId) return "courseId is required, at most 200 characters";
  if (!userId) return "user.id is required, at most 100 characters";

  const fields = { courseUrl: b.courseUrl, courseTitle: b.courseTitle, title: b.title, loRoute: b.loRoute, img: b.img, type: b.type };
  const userFields = { fullName: u.fullName, avatar: u.avatar, sentiment: u.sentiment };
  const record: Record<string, unknown> = { courseId };
  for (const [key, value] of Object.entries(fields)) {
    const checked = text(value, MAX_TEXT);
    if (checked === false) return `${key} must be a string of at most ${MAX_TEXT} characters`;
    if (checked !== undefined) record[key] = checked;
  }
  const user: Record<string, unknown> = { id: userId };
  for (const [key, value] of Object.entries(userFields)) {
    const checked = text(value, MAX_TEXT);
    if (checked === false) return `user.${key} must be a string of at most ${MAX_TEXT} characters`;
    if (checked !== undefined) user[key] = checked;
  }
  record.user = user;
  if (b.isPrivate !== undefined) {
    if (typeof b.isPrivate !== "boolean") return "isPrivate must be a boolean";
    record.isPrivate = b.isPrivate;
  }
  if (b.icon !== undefined && b.icon !== null) {
    if (typeof b.icon !== "object" || Array.isArray(b.icon)) return "icon must be an object of strings";
    const entries = Object.entries(b.icon as Record<string, unknown>);
    if (entries.length > MAX_ICON_KEYS || entries.some(([, value]) => typeof value !== "string" || value.length > MAX_TEXT)) return "icon must be an object of strings";
    record.icon = Object.fromEntries(entries);
  }
  return record as unknown as PresenceEvent;
}
