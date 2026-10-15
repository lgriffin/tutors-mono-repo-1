import type { Unsubscribe } from "./presence.ts";

/**
 * A content-free "a snippet was shared with this course" ping for its educators. It crosses a
 * channel any student may join, so it carries no learner, no title and no body: a receiver
 * re-reads the snippets through a route that checks who is asking.
 */
export type SnippetSharedNotice = {
  type: "gist-created";
  /** Stable id, so a tab that hears the notice twice shows it once. */
  id: string;
  courseId: string;
  sentAt: number;
};

/** A lecturer's message to every student reading the course right now. */
export type LecturerBroadcast = {
  type: "course:broadcast";
  id: string;
  courseId: string;
  title: string;
  description: string;
  actionUrl?: string;
  actionLabel?: string;
  senderName: string;
  sentAt: number;
};

export type CourseNotice = SnippetSharedNotice | LecturerBroadcast;
export type CourseNoticeType = CourseNotice["type"];

/**
 * Delivers notices to the browsers that watch a course. Posting is the server's: a browser's
 * adapter hands the notice to the app's own server, which publishes it within the budget.
 */
export interface CourseNotices {
  /** Resolves false when the notice was not accepted (not configured, refused, rate-limited). */
  post(notice: CourseNotice): Promise<boolean>;
  /** Hear every notice of one type for a course. */
  watch(courseId: string, type: CourseNoticeType, listener: (notice: CourseNotice) => void): Unsubscribe;
}
