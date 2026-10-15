import { pseudonymise, type TutorsTimeRows } from "@tutors/domain/learning";
import type { LearningRecords } from "../ports/learning-records.ts";

export type TimeRowsDeps = { records: LearningRecords; randomId?: () => string };

/**
 * A course's time data for a viewer: in full for an educator, pseudonymised for anyone else (Rules
 * 0066 and 0075). `randomId` is the source of pseudonyms; the platform's random UUID by default.
 */
export const loadTimeRows = ({ records, randomId = () => crypto.randomUUID() }: TimeRowsDeps) =>
  async (viewer: { login: string; educator: boolean }, courseId: string, start?: string | null, end?: string | null): Promise<TutorsTimeRows> => {
    const rows = await records.timeRows(courseId, start, end);
    return viewer.educator ? rows : pseudonymise(rows, viewer.login, randomId);
  };
