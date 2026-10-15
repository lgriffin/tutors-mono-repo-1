import type { HourlyRow, HourlySessionRow, LiveEvent, LoTotals, Range, SessionRow } from "@tutors/domain/live";

/** The rollups and session rows the dashboard's Recent and Trend layers are computed from. */
export interface ActivityRead {
  /** Views and service touches per hour, course, service and learning-object type. */
  hourly(range: Range): Promise<HourlyRow[]>;
  /** Distinct sessions per hour per course; never summed across the rows of `hourly`. */
  hourlySessions(range: Range): Promise<HourlySessionRow[]>;
  /** Completed sessions overlapping the range. The exact source for counts and durations. */
  sessions(range: Range): Promise<SessionRow[]>;
  /** Every course seen in the range, for the course filter. */
  courses(range: Range): Promise<string[]>;
  /** The most opened learning objects, for the course drill-down. */
  topLos(range: Range, limit: number): Promise<LoTotals[]>;
}

/** What the ingest use case writes. */
export interface ActivityWrite {
  /** Appends raw events, with timestamps already coarsened to the minute. */
  append(events: LiveEvent[]): Promise<void>;
  /** Records a session that has ended. Re-recording the same session replaces it. */
  upsertSession(session: SessionRow): Promise<void>;
  /** Opt-out: removes a learner's `uid` from raw events and sessions. */
  purgeUid(uid: string): Promise<number>;
}

/** Raw events plus the rollups the dashboard reads, behind one adapter. */
export interface LiveWarehouse extends ActivityRead, ActivityWrite {
  readonly kind: string;
  close(): Promise<void>;
}
