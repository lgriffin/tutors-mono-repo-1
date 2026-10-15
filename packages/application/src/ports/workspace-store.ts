import type { Workspace } from "@tutors/domain/course/playground";

/** Keeps a student's playground edits between visits; no account is needed. */
export interface WorkspaceStore {
  load(courseId: string, loId: string): Promise<Workspace | null>;
  save(workspace: Workspace): Promise<void>;
  remove(courseId: string, loId: string): Promise<void>;
}
