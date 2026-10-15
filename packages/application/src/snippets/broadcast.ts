import type { Clock } from "../ports/clock.ts";
import type { CourseNotices, LecturerBroadcast } from "../ports/course-notices.ts";

/** One broadcast per course per minute: enough to say "the quiz is open", not enough to spam a class. */
export const BROADCAST_RATE_LIMIT_MS = 60_000;

/** What the lecturer composes. */
export type BroadcastMessage = {
  title: string;
  description: string;
  actionUrl?: string;
  actionLabel?: string;
};

const field = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value.trim() : undefined);

/**
 * A lecturer's message, copied field by field.
 * @returns the message, or the reason it was refused
 */
export function parseBroadcastMessage(body: unknown): BroadcastMessage | string {
  if (!body || typeof body !== "object") return "body is not an object";
  const b = body as Record<string, unknown>;
  const title = field(b.title, 80);
  const description = field(b.description, 280);
  if (!title) return "title is required, at most 80 characters";
  if (!description) return "description is required, at most 280 characters";
  const actionUrl = field(b.actionUrl ?? "", 1000);
  const actionLabel = field(b.actionLabel ?? "", 24);
  if (actionUrl === undefined || actionLabel === undefined) return "actionUrl and actionLabel are strings";
  return { title, description, actionUrl: actionUrl || undefined, actionLabel: actionLabel || undefined };
}

/** Remembers when each course was last broadcast to, so the limit holds across requests. */
export interface BroadcastLimiter {
  /** True, and the instant recorded, when a broadcast to the course may go out at `nowMs`. */
  allow(courseId: string, nowMs: number): boolean;
}

export function createBroadcastLimiter(windowMs: number = BROADCAST_RATE_LIMIT_MS): BroadcastLimiter {
  const lastSentAt = new Map<string, number>();
  return {
    allow(courseId, nowMs) {
      const last = lastSentAt.get(courseId) ?? Number.NEGATIVE_INFINITY;
      if (nowMs - last < windowMs) return false;
      lastSentAt.set(courseId, nowMs);
      return true;
    }
  };
}

export type BroadcastDeps = {
  notices: CourseNotices;
  clock: Clock;
  limiter: BroadcastLimiter;
  newId?: () => string;
};

export type BroadcastResult = { ok: true; broadcast: LecturerBroadcast } | { ok: false; reason: "empty" | "rate-limited" | "failed" };

const uuid = () => `bc-${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/**
 * Sends a lecturer's message to every student reading the course, at most once a minute per
 * course. The sender's name falls back to "Tutor" so a student always sees who is speaking.
 */
export function broadcastToCourse({ notices, clock, limiter, newId = uuid }: BroadcastDeps) {
  return async (courseId: string, message: BroadcastMessage, senderName: string): Promise<BroadcastResult> => {
    if (!courseId || !message.title.trim() || !message.description.trim()) return { ok: false, reason: "empty" };
    const now = clock.nowMs();
    if (!limiter.allow(courseId, now)) return { ok: false, reason: "rate-limited" };
    const broadcast: LecturerBroadcast = {
      type: "course:broadcast",
      id: newId(),
      courseId,
      title: message.title.trim(),
      description: message.description.trim(),
      actionUrl: message.actionUrl?.trim() || undefined,
      actionLabel: message.actionLabel?.trim() || undefined,
      senderName: senderName.trim() || "Tutor",
      sentAt: now
    };
    const posted = await notices.post(broadcast).catch(() => false);
    return posted ? { ok: true, broadcast } : { ok: false, reason: "failed" };
  };
}
