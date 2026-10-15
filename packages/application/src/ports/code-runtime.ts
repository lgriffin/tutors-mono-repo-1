/**
 * Running student code: the conversation between a page and a sandboxed run-time.
 *
 * It is deliberately shaped like Jupyter's execute request: a request produces a stream of
 * output, then exactly one terminal event. Notebooks and playgrounds are the same conversation
 * with different framing, so both drive this one port and neither knows which language engine,
 * or which sandbox, is on the other end.
 */
import type { PlaygroundRuntime } from "@tutors/domain/course";
import type { WorkspaceFile } from "@tutors/domain/course/playground";

export type RuntimeId = PlaygroundRuntime;

/** Namespace on every message between a page and its sandbox, so a stray `postMessage` from anything else is ignored. */
export const RUNTIME_NAMESPACE = "tutors-runtime";

export type RuntimeFile = WorkspaceFile;

/**
 * How a request is executed.
 *
 * `script` is a program: a fresh namespace, files written out, entry point run (a playground's
 * Run button). `cell` is a notebook cell: it shares the namespace with every earlier cell, which
 * is the whole reason a kernel is long-lived. `test` runs the workspace's checks and reports
 * pass or fail.
 */
export type ExecutionMode = "script" | "cell" | "test";

export type ExecuteRequest = {
  id: string;
  runtime: RuntimeId;
  mode: ExecutionMode;
  /** Workspace contents. For `cell`, the single cell's source is the only entry. */
  files: RuntimeFile[];
  entry: string;
  packages?: string[];
  stdin?: string;
};

export type ExecutionPhase = "booting" | "installing" | "running" | "idle";

export type RuntimeEvent =
  | { type: "ready" }
  | { type: "status"; id?: string; phase: ExecutionPhase; detail?: string }
  | { type: "stream"; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "result"; id: string; value: string }
  | { type: "error"; id: string; message: string }
  | { type: "done"; id: string; ok: boolean; durationMs: number };

/** Everything one execution produced, for callers that would rather await than subscribe. */
export type ExecutionResult = {
  ok: boolean;
  /** stdout and stderr interleaved in the order they were produced, as the student sees it. */
  output: string;
  stderr: string;
  value: string;
  error: string;
  durationMs: number;
};

/** One long-lived execution context: a notebook keeps one so cells share a namespace; a playground runs whole programs through one. */
export interface CodeRuntime {
  readonly runtime: RuntimeId;
  /** Listen to everything the run-time emits, until the returned function is called. */
  subscribe(onEvent: (event: RuntimeEvent) => void): () => void;
  /** Bring the run-time up; `execute` calls it implicitly. */
  start(): Promise<void>;
  /** Run one request to completion. Output streams through the listeners as it arrives; the result is the same output gathered up. */
  execute(request: Omit<ExecuteRequest, "id"> & { id?: string }): Promise<ExecutionResult>;
  /** Stop whatever is running now. The run-time comes back empty. */
  stop(): void;
  /** Discard all execution state: a notebook's Restart Kernel. */
  restart(): void;
  dispose(): void;
}

export type CodeRuntimeOptions = {
  runtime: RuntimeId;
  /** A run that never finishes would hold the Run button hostage, so every run has a ceiling. */
  timeoutMs?: number;
  onEvent?: (event: RuntimeEvent) => void;
};

/** Where student code runs: opens a run-time for one language. */
export interface CodeRuntimePort {
  open(options: CodeRuntimeOptions): CodeRuntime;
}
