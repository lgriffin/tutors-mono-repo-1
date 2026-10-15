import type { Service } from "./catalogue.ts";

/**
 * The shapes the dashboard reads: what presence looks like this minute, and the
 * rollup rows a warehouse answers with. The seams that produce them (the bus,
 * the presence store, the warehouse) are ports of the application ring; these
 * are the vocabulary the ports and the metrics share.
 */

/** Who is doing what right now, for the "Now" layer of the dashboard. */
export interface NowSnapshot {
  /** Sessions with a heartbeat inside the active window. */
  activeSessions: number;
  courses: CourseNow[];
  services: ServiceCount[];
  /** One row per active session, most recently seen first. */
  sessions: ActiveSession[];
  updatedAt: string;
}

/**
 * One session that is open right now.
 *
 * It carries a `handle` rather than the session token: the token is already
 * anonymous and rotates daily, but there is no reason for a public page to
 * echo it, and a short derived label distinguishes rows just as well.
 */
export interface ActiveSession {
  handle: string;
  course: string;
  /** What it is reading, when the session has said. */
  lo?: string;
  lastSeen: string;
  /** Seconds since the last event, so the UI need not diff clocks. */
  idleSec: number;
}

export interface CourseNow {
  course: string;
  active: number;
  /** The learning objects those sessions are on, most popular first. */
  los: { lo: string; count: number }[];
}

export interface ServiceCount {
  service: Service;
  count: number;
}

/** One hour of activity for one (course, service, loType) combination. */
export interface HourlyRow {
  /** Start of the hour, ISO 8601 UTC. */
  bucket: string;
  course: string;
  service: string | null;
  loType: string | null;
  views: number;
  serviceTouches: number;
}

/**
 * Distinct sessions per hour per course.
 *
 * Kept apart from `HourlyRow` on purpose: a distinct count cannot be summed
 * across the (service, loType) rows of the same hour, so mixing the two in one
 * rollup is the standard way to over-count sessions by a factor of five.
 */
export interface HourlySessionRow {
  bucket: string;
  course: string;
  sessions: number;
}

/** One learning object and how often it was opened. */
export interface LoTotals {
  lo: string;
  loType: string;
  views: number;
}

/** One completed session. The exact source for session counts and durations. */
export interface SessionRow {
  sid: string;
  course: string;
  /** Present only for a logged-in learner who opted in. */
  uid: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
}

/** A closed time range, used by every warehouse query. */
export interface Range {
  from: Date;
  to: Date;
  course?: string;
}

/** Start of the hour an event falls in, ISO 8601 UTC. */
export function hourBucket(ts: string): string {
  const date = new Date(Date.parse(ts));
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}
