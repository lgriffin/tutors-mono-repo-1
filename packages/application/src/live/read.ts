import {
  activityReport,
  courseActivityHeatmap,
  dailySeries,
  headlineStats,
  observe,
  rangeFor,
  serviceDayHeatmap,
  serviceHourHeatmap,
  serviceMix,
  topCourses,
  type ActivityReport,
  type CourseTotals,
  type HeadlineStats,
  type HeatmapKind,
  type HeatmapMatrix,
  type LoTotals,
  type Observation,
  type RangeName,
  type SeriesPoint,
  type ServiceMixEntry,
  type TermWindow
} from "@tutors/domain/live";
import type { ActivityRead } from "../ports/live-warehouse.ts";
import type { LivePresenceStore } from "../ports/live-presence-store.ts";

/**
 * The read model behind `/api/live/*`.
 *
 * Use cases over the ActivityRead and LivePresenceStore ports, so the answers can be
 * tested against the in-memory adapters without standing up SvelteKit, and so the same
 * queries are available to anything else that wants them.
 */

export interface StatsResponse {
  range: RangeName;
  course: string | null;
  stats: HeadlineStats;
  series: SeriesPoint[];
  serviceMix: ServiceMixEntry[];
  topCourses: CourseTotals[];
  /** Present only when a course is selected: its most opened learning objects. */
  topLos?: LoTotals[];
  generatedAt: string;
}

/** Everything the headline row, the sparkline and the top-courses table need, in one query pass. */
export async function statsFor(
  warehouse: ActivityRead,
  name: RangeName,
  course: string | null,
  now: Date = new Date()
): Promise<StatsResponse> {
  const range = rangeFor(name, now, course ?? undefined);
  const [hourly, hourlySessions, sessions] = await Promise.all([
    warehouse.hourly(range),
    warehouse.hourlySessions(range),
    warehouse.sessions(range)
  ]);

  return {
    range: name,
    course,
    stats: headlineStats(name, course, sessions, hourly),
    series: dailySeries(range, hourlySessions, hourly),
    serviceMix: serviceMix(hourly),
    topCourses: topCourses(sessions, hourly),
    ...(course ? { topLos: await warehouse.topLos(range, 10) } : {}),
    generatedAt: now.toISOString()
  };
}

/** One heat map, built from the rollups the kind needs and nothing more. */
export async function heatmapFor(
  warehouse: ActivityRead,
  kind: HeatmapKind,
  name: RangeName,
  course: string | null,
  now: Date = new Date()
): Promise<HeatmapMatrix> {
  const range = rangeFor(name, now, course ?? undefined);
  if (kind === "course") return courseActivityHeatmap(range, await warehouse.hourlySessions(range));
  const hourly = await warehouse.hourly(range);
  return kind === "service-monthly" ? serviceDayHeatmap(range, hourly) : serviceHourHeatmap(hourly);
}

/** How far back "has this service been used?" looks, per range. */
const SILENT_SERVICE_DAYS: Record<RangeName, number> = { today: 1, "7d": 7, "30d": 30 };

/**
 * The observation cards.
 *
 * The rules always read 35 days of session rollups, whatever range is selected -
 * the spike rule compares today against the four previous same weekdays, and
 * there is no shorter window that can answer it. The range only decides how long
 * a service has to go untouched before it is called silent.
 */
export async function observationsFor(
  warehouse: ActivityRead,
  name: RangeName,
  now: Date = new Date(),
  terms: TermWindow[] = []
): Promise<Observation[]> {
  const lookback = { from: new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000), to: now };
  const silentServiceDays = SILENT_SERVICE_DAYS[name];
  const serviceWindow = { from: new Date(now.getTime() - silentServiceDays * 24 * 60 * 60 * 1000), to: now };

  const [hourlySessions, hourly] = await Promise.all([warehouse.hourlySessions(lookback), warehouse.hourly(serviceWindow)]);
  return observe({ hourlySessions, hourly, now, options: { silentServiceDays, terms } });
}

export interface ActivityResponse extends ActivityReport {
  range: RangeName;
  course: string | null;
  generatedAt: string;
}

/**
 * The activity panel: per-course last seen, sessions, visitors and how many
 * came back, plus the repeat-visit histogram.
 *
 * Presence is folded in from the hot store so "last seen" is not stuck at the
 * last session that ended while somebody is still reading.
 */
export async function activityFor(
  warehouse: ActivityRead,
  hot: LivePresenceStore,
  name: RangeName,
  course: string | null,
  now: Date = new Date()
): Promise<ActivityResponse> {
  const range = rangeFor(name, now, course ?? undefined);
  const [sessions, hourly, snapshot] = await Promise.all([warehouse.sessions(range), warehouse.hourly(range), hot.now(now)]);

  const presence: Record<string, number> = {};
  for (const entry of snapshot.courses) {
    if (course === null || entry.course === course) presence[entry.course] = entry.active;
  }

  const report = activityReport(sessions, hourly, presence);
  const liveLastSeen = snapshot.sessions.length > 0 ? snapshot.updatedAt : null;

  return {
    ...report,
    lastSeen: report.lastSeen && liveLastSeen ? (report.lastSeen > liveLastSeen ? report.lastSeen : liveLastSeen) : (report.lastSeen ?? liveLastSeen),
    courses: report.courses.map((entry) =>
      entry.activeNow > 0 ? { ...entry, lastSeen: entry.lastSeen && entry.lastSeen > snapshot.updatedAt ? entry.lastSeen : snapshot.updatedAt } : entry
    ),
    range: name,
    course,
    generatedAt: now.toISOString()
  };
}

/** The courses the filter offers, over the widest range the dashboard shows. */
export async function coursesFor(warehouse: ActivityRead, now: Date = new Date()): Promise<string[]> {
  return warehouse.courses(rangeFor("30d", now));
}
