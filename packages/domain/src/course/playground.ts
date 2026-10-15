/**
 * What a playground's workspace is: the authored files with a student's edits laid over
 * them, and the editor grammar each file wants. Where it is kept and how it runs are ports
 * (WorkspaceStore, CodeRuntimePort); these are the rules both sides share. The link form a
 * workspace takes when shared is the UI's (share-link.ts), since it is made of browser APIs.
 */
import type { Playground, PlaygroundFile, PlaygroundRuntime } from "./types/learning-objects.ts";

/** One file of a workspace as it is edited, stored and run. */
export type WorkspaceFile = { path: string; content: string };

/** A student's saved copy of a playground's workspace. */
export type Workspace = {
  courseId: string;
  loId: string;
  files: WorkspaceFile[];
  entry: string;
  updatedAt: string;
};

/**
 * The authored workspace with saved edits applied.
 *
 * Authored files win on read-only status, saved content wins on content: a lecturer adding a
 * file to the exercise must reach students who already started, while a student's own edits
 * must not be silently reverted. Anything in storage that the exercise no longer mentions is
 * kept: storage does not record who created a file, so a withdrawn scaffold and a file the
 * student made look alike, and keeping both is the side that loses no work.
 */
export function mergeWorkspace(playground: Playground, saved: Workspace | null): WorkspaceFile[] {
  const authored = playground.files ?? [];
  if (!saved) return authored.map((file) => ({ path: file.path, content: file.content }));

  const savedByPath = new Map(saved.files.map((file) => [file.path, file.content]));
  const authoredPaths = new Set(authored.map((file) => file.path));

  const merged = authored.map((file) => ({
    path: file.path,
    // A read-only file is scaffolding; a stale copy of it in storage must not override the
    // version the lecturer is now shipping.
    content: file.readOnly ? file.content : (savedByPath.get(file.path) ?? file.content)
  }));

  for (const file of saved.files) {
    if (!authoredPaths.has(file.path)) merged.push({ path: file.path, content: file.content });
  }
  return merged;
}

export function isReadOnly(playground: Playground, path: string): boolean {
  return playground.files?.some((file: PlaygroundFile) => file.path === path && file.readOnly === true) ?? false;
}

export function runtimeLabel(runtime: PlaygroundRuntime): string {
  return { python: "Python", javascript: "JavaScript", typescript: "TypeScript" }[runtime] ?? runtime;
}

export function runtimeFileExtension(runtime: PlaygroundRuntime): string {
  return { python: "py", javascript: "js", typescript: "ts" }[runtime] ?? "txt";
}

export type EditorLanguage = "python" | "javascript" | "typescript" | "json" | "text";

/** Which editor grammar a file wants, which is its own extension rather than the kernel's. */
export function languageForPath(path: string, fallback: PlaygroundRuntime): EditorLanguage {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "py":
      return "python";
    case "js":
    case "mjs":
      return "javascript";
    case "ts":
      return "typescript";
    case "json":
      return "json";
    case "txt":
    case "csv":
    case "md":
      return "text";
    default:
      return fallback;
  }
}
