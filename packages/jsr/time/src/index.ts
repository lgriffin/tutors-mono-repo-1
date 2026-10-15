/**
 * @tutors/tutors-time-lib is a facade for one major version: the learning-activity domain
 * (calendar and lab models, their types and formatting helpers) now lives in
 * @tutors/domain/learning. The time source stays here: it reads a course's rows from the reader's
 * data API. 6.0.0 removed the Supabase source (`supabaseTimeSource`, `getSupabase`, `initSupabase`):
 * no browser reads the tables with the anon key any more (Rule 0471); every other export is unchanged.
 */
export type {
  CalendarEntry,
  CalendarMedianRow,
  CalendarMedianTable,
  CalendarModel,
  CalendarRow,
  CalendarTable,
  CourseDisplayInfo,
  LabMedianRow,
  LabMedianTable,
  LabModel,
  LabRow,
  LabTable,
  LabViewMode,
  LearningRecord,
  StudentDisplayInfo,
  TutorsConnectCourse,
  TutorsConnectUser,
  TutorsTimeCourse,
  TutorsTimeService,
  TutorsTimeStudent,
  ViewMode
} from "@tutors/domain/learning";
export {
  extractLabIdentifier,
  extractStepName,
  filterByDateRange,
  formatDateShort,
  formatTimeMinutesOnly,
  formatTimeNearestMinute,
  getDistinctSortedDates,
  getDistinctSortedDatesFromRecords,
  getDistinctSortedWeeks,
  getMondayForDate,
  heatColor,
  minutesOf,
  toggleLabViewMode
} from "@tutors/domain/learning";
export { BaseCalendarModel, BaseLabModel } from "@tutors/domain/learning";
// Where a course id's tutors.json is served; the time app's PIN and educator checks read it.
export { courseJsonUrl } from "@tutors/domain/course";

export { readerTimeSource, setTutorsTimeSource, getTutorsTimeSource, TutorsTimeSourceError, withoutTrailingSlashes } from "./services/source.ts";
export type { TutorsTimeSource, TutorsTimeRows } from "./services/source.ts";
export { CourseTime } from "./services/course-time.ts";
export { TutorsTime } from "./services/tutors-time.ts";
