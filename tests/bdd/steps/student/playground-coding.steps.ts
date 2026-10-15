// @vitest-environment happy-dom
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { inertFrames, makeKernel } from "../../../support/runtime-kernel-harness";
import { RUNTIME_NAMESPACE, type ExecutionResult, type RuntimeEvent } from "../../../../packages/application/src/ports/code-runtime.ts";
import { isReadOnly, mergeWorkspace, type Workspace, type WorkspaceFile } from "../../../../packages/domain/src/course/playground.ts";
import { decodeShareLink, encodeShareLink } from "../../../../packages/adapters/driving/ui-components/src/learning-objects/content/playground/share-link.ts";
import { InMemoryWorkspaceStore } from "../../../../packages/application/src/testing/in-memory.ts";
import type { Playground } from "../../../../packages/domain/src/course/types/learning-objects";

/**
 * A student working through a playground, from the page's side of the sandbox.
 *
 * The run-time itself is a stand-in: what these check is the behaviour a student would
 * notice — that their code runs somewhere it cannot touch the reader, that their work
 * survives, and that nothing hangs when the code does.
 */

const feature = await loadFeature("tests/bdd/features/student/playground-coding.feature");

function playgroundLo(files: Playground["files"], extra: Partial<Playground> = {}): Playground {
  return { type: "playground", runtime: "python", entry: "main.py", files, ...extra } as Playground;
}

const list = (csv: string) => csv.split(",").map((item) => item.trim());

describeFeature(feature, ({ Rule, BeforeEachScenario, AfterEachScenario }) => {
  let kernel: ReturnType<typeof makeKernel>;
  let seen: RuntimeEvent[];
  let streamed: string[];
  let run: Promise<ExecutionResult>;
  let result: ExecutionResult;
  let lo: Playground;
  let store: InMemoryWorkspaceStore;
  let saved: Workspace | null;
  let workspace: WorkspaceFile[];
  let encoded: string;
  let decoded: { files: WorkspaceFile[]; entry: string } | null;

  BeforeEachScenario(() => {
    inertFrames();
    seen = [];
    streamed = [];
    store = new InMemoryWorkspaceStore();
    saved = null;
    workspace = [];
  });

  AfterEachScenario(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const opensPlayground = () => {
    kernel = makeKernel();
    kernel.kernel.subscribe((event) => {
      seen.push(event);
      if (event.type === "stream") streamed.push(event.text);
    });
    kernel.host.ready();
  };

  const sentFiles = () => {
    const execute = kernel.host.sent.find((message) => message.type === "execute") as Record<string, unknown>;
    return { mode: execute.mode, paths: (execute.files as Array<{ path: string }>).map((file) => file.path) };
  };

  const playgroundOf = (_ctx: unknown, path: string, content: string) => {
    lo = playgroundLo([{ path, content }]);
  };
  const studentSaved = async (_ctx: unknown, path: string, content: string) => {
    await store.save({ courseId: "course", loId: "lo", files: [{ path, content }], entry: "main.py", updatedAt: "2026-09-10T09:00:00.000Z" });
  };
  const reopens = async () => {
    saved = await store.load("course", "lo");
    workspace = mergeWorkspace(lo, saved);
  };
  const reads = (_ctx: unknown, path: string, content: string) => {
    expect(workspace.find((file) => file.path === path)?.content).toBe(content);
  };
  const holds = (_ctx: unknown, path: string) => {
    expect(workspace.map((file) => file.path)).toContain(path);
  };
  const holdsOnly = (_ctx: unknown, path: string) => {
    expect(workspace.map((file) => file.path)).toEqual([path]);
  };
  const failedWith = async (_ctx: unknown, text: string) => {
    result = await run;
    expect(result.ok).toBe(false);
    expect(result.output).toContain(text);
  };

  Rule("The reader shall run a student's playground code in a sandboxed frame on an origin of its own.", ({ RuleScenario }) => {
    RuleScenario("Student code never runs on the reader's own origin", ({ Given, Then, And }) => {
      Given("a student opens a playground", opensPlayground);
      Then("the reader frames the run-time with scripts allowed and the reader's origin withheld", () => {
        const frame = kernel.container.querySelector("iframe") as HTMLIFrameElement;
        expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
        expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      });
      And("the reader addresses that frame with a token of its own", () => {
        const second = makeKernel();
        expect(kernel.host.token).not.toBe("");
        expect(kernel.host.token).not.toBe(second.host.token);
      });
      And("the reader ignores run-time messages from anywhere else on the page", () => {
        const before = seen.length;
        kernel.host.impersonate({ ns: RUNTIME_NAMESPACE, token: kernel.host.token, event: { type: "ready", runtime: "python" } });
        kernel.host.reply({ type: "ready", runtime: "python" }, { token: "another-kernel" });
        expect(seen.length).toBe(before);
      });
    });
  });

  Rule("When a student runs a playground, the reader shall send the whole workspace to the run-time and show its output with a verdict.", ({ RuleScenario }) => {
    RuleScenario("Run the code in the workspace", ({ Given, When, Then }) => {
      Given("a student opens a playground", opensPlayground);
      When("the student runs a workspace of {string} and {string}", async (_ctx, first: string, second: string) => {
        void kernel.kernel.execute({
          runtime: "python",
          mode: "script",
          entry: first,
          files: [
            { path: first, content: "from helper import double" },
            { path: second, content: "def double(n): return n * 2" }
          ]
        });
        await kernel.host.execution();
      });
      Then("the run-time receives the files {string} and {string}", (_ctx, first: string, second: string) => {
        expect(sentFiles().paths).toEqual([first, second]);
      });
    });

    RuleScenario("Output arrives as it is printed", ({ Given, When, Then }) => {
      Given("a student opens a playground", opensPlayground);
      When("the run-time prints {string} while the code is still running", async (_ctx, text: string) => {
        run = kernel.kernel.execute({ runtime: "python", mode: "script", files: [], entry: "main.py" });
        const id = await kernel.host.execution();
        kernel.host.reply({ type: "stream", id, stream: "stdout", text: `${text}\n` });
      });
      Then("the student sees {string} before the run has finished", (_ctx, text: string) => {
        expect(streamed).toEqual([`${text}\n`]);
        kernel.kernel.stop();
      });
    });

    RuleScenario("A failed run is reported as one", ({ Given, When, Then }) => {
      Given("a student opens a playground", opensPlayground);
      When("the run-time reports a {string} and finishes", async (_ctx, message: string) => {
        run = kernel.kernel.execute({ runtime: "python", mode: "script", files: [], entry: "main.py" });
        const id = await kernel.host.execution();
        kernel.host.reply({ type: "error", id, message });
        kernel.host.reply({ type: "done", id, ok: false, durationMs: 2 });
      });
      Then("the run is reported as failed with {string} in its output", failedWith);
    });
  });

  Rule("When a student runs the checks of a playground, the reader shall send the tests alongside the student's files without adding them to the workspace.", ({ RuleScenario }) => {
    RuleScenario("Run the checks the lecturer wrote", ({ Given, When, Then, And }) => {
      Given("a playground of {string} with a tests file {string}", (_ctx, main: string, tests: string) => {
        lo = playgroundLo([{ path: main, content: "def double(n): return n" }], { tests: { path: tests, content: "assert double(2) == 4" } });
      });
      When("the student runs the checks", async () => {
        opensPlayground();
        workspace = mergeWorkspace(lo, null);
        void kernel.kernel.execute({ runtime: "python", mode: "test", entry: lo.entry, files: [...workspace, { path: lo.tests!.path, content: lo.tests!.content }] });
        await kernel.host.execution();
      });
      Then("the run-time receives a test run of {string} and {string}", (_ctx, main: string, tests: string) => {
        expect(sentFiles().mode).toBe("test");
        expect(sentFiles().paths).toEqual([main, tests]);
      });
      And("the student's workspace holds {string} only", holdsOnly);
    });
  });

  Rule("While a student has edited a playground before, the reader shall reopen the exercise with their edits and their own files in place.", ({ RuleScenario }) => {
    RuleScenario("Work is kept between visits without an account", ({ Given, And, When, Then }) => {
      Given("a playground of {string} reading {string}", playgroundOf);
      And("the student saved {string} reading {string} and a file of their own {string}", async (_ctx, path: string, content: string, own: string) => {
        await store.save({
          courseId: "course",
          loId: "lo",
          files: [
            { path, content },
            { path: own, content: "# working it out" }
          ],
          entry: "main.py",
          updatedAt: "2026-09-10T09:00:00.000Z"
        });
      });
      When("the student reopens the playground", reopens);
      Then("{string} reads {string}", reads);
      And("the workspace holds {string}", holds);
    });

    RuleScenario("A first visit opens the exercise as authored", ({ Given, When, Then, And }) => {
      Given("a playground of {string} reading {string}", playgroundOf);
      When("the student reopens the playground", reopens);
      Then("{string} reads {string}", reads);
      And("the workspace holds {string} only", holdsOnly);
    });
  });

  Rule("When a lecturer adds a file to a playground a student has edited, the reader shall deliver the new file beside the student's unchanged edits.", ({ RuleScenario }) => {
    RuleScenario("The lecturer adds a file to an exercise already started", ({ Given, And, When, Then }) => {
      Given("a playground of {string} reading {string}", playgroundOf);
      And("the student saved {string} reading {string}", studentSaved);
      When("the lecturer adds {string} to the exercise", (_ctx, path: string) => {
        lo = playgroundLo([...lo.files, { path, content: "def double(n): return n * 2" }]);
      });
      And("the student reopens the playground", reopens);
      Then("the workspace holds {string}", holds);
      And("{string} reads {string}", reads);
    });
  });

  Rule("Where the author marked a playground file read-only, the reader shall present that file as read-only in its current authored version.", ({ RuleScenario }) => {
    RuleScenario("Scaffolding the student is not meant to change", ({ Given, And, When, Then }) => {
      Given("a playground whose {string} is read-only and reads {string}", (_ctx, path: string, content: string) => {
        lo = playgroundLo([
          { path, content, readOnly: true },
          { path: "main.py", content: "print('todo')" }
        ]);
      });
      And("the student saved {string} reading {string}", studentSaved);
      When("the student reopens the playground", reopens);
      Then("{string} is read-only", (_ctx, path: string) => {
        expect(isReadOnly(lo, path)).toBe(true);
      });
      And("{string} reads {string}", reads);
    });

    RuleScenario("An ordinary file stays the student's own", ({ Given, And, When, Then }) => {
      Given("a playground of {string} reading {string}", playgroundOf);
      And("the student saved {string} reading {string}", studentSaved);
      When("the student reopens the playground", reopens);
      Then("{string} is editable", (_ctx, path: string) => {
        expect(isReadOnly(lo, path)).toBe(false);
      });
      And("{string} reads {string}", reads);
    });
  });

  Rule("When a student shares a playground as a link, the reader shall carry the whole workspace in the link's fragment.", ({ RuleScenario }) => {
    RuleScenario("Share a workspace with someone who is not signed in", ({ Given, When, Then, And }) => {
      Given("a student has a workspace of {string} and {string}", (_ctx, first: string, second: string) => {
        workspace = [
          { path: first, content: "print('look at this')" },
          { path: second, content: "def double(n): return n * 2" }
        ];
      });
      When("the student shares it as a link", async () => {
        encoded = await encodeShareLink(workspace, "main.py");
      });
      Then("the link decodes to the same workspace", async () => {
        expect(await decodeShareLink(encoded)).toEqual({ files: workspace, entry: "main.py" });
      });
      And("the link carries the workspace in its fragment and nothing in its query", () => {
        const url = new URL(`https://reader.test/playground/course/topic/lo#w=${encoded}`);
        expect(url.hash.slice(3)).toBe(encoded);
        expect(url.search).toBe("");
      });
    });
  });

  Rule("If a playground run is still running after the time limit, then the reader shall stop it, say so and discard the run-time.", ({ RuleScenario }) => {
    RuleScenario("Code that never finishes", ({ Given, When, Then, And }) => {
      Given("a student opens a playground with a time limit of {number} milliseconds", (_ctx, limit: number) => {
        kernel = makeKernel("python", limit);
        kernel.host.ready();
      });
      When("the run-time never answers the run", async () => {
        result = await kernel.kernel.execute({ runtime: "python", mode: "script", files: [], entry: "main.py" });
      });
      Then("the run is reported as failed because it was still running", () => {
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/still running/);
      });
      And("the run-time is restarted", () => {
        expect(kernel.host.restarted()).toBe(true);
      });
    });
  });

  Rule("If a student stops a playground run, then the reader shall answer the waiting run as stopped.", ({ RuleScenario }) => {
    RuleScenario("A student changes their mind mid-run", ({ Given, When, Then }) => {
      Given("a student opens a playground", opensPlayground);
      When("the student presses stop during a run", async () => {
        run = kernel.kernel.execute({ runtime: "python", mode: "script", files: [], entry: "main.py" });
        await kernel.host.execution();
        kernel.kernel.stop();
      });
      Then("the run is reported as failed with {string} in its output", failedWith);
    });
  });

  Rule("If a shared link's fragment is not a workspace, then the reader shall open the exercise as authored.", ({ RuleScenario }) => {
    RuleScenario("A shared link that is not one", ({ Given, When, Then, And }) => {
      Given("a playground of {string} reading {string}", playgroundOf);
      When("the student opens a link whose fragment is {string}", async (_ctx, fragment: string) => {
        decoded = await decodeShareLink(fragment);
        workspace = decoded ? decoded.files : mergeWorkspace(lo, null);
      });
      Then("the link decodes to nothing", () => {
        expect(decoded).toBeNull();
      });
      And("{string} reads {string}", reads);
    });
  });
});
