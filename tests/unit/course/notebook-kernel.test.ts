// @vitest-environment happy-dom
/**
 * One kernel per notebook: which kernel languages run, the kernel started lazily on first use
 * through the composed CodeRuntimePort, Run All driving the cells in order, and Restart Kernel.
 * The scripted run-time stands in for the browser sandbox.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { ScriptedCodeRuntimePort } from "../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { createNotebookKernel, runtimeForKernelLanguage } from "../../../packages/adapters/driving/svelte-state/src/course/services/notebook-kernel.svelte.ts";

let port: ScriptedCodeRuntimePort;

beforeEach(() => {
  port = new ScriptedCodeRuntimePort();
  configureAdapters(anonymousAdapters({ codeRuntime: port }));
});

describe("runtimeForKernelLanguage", () => {
  it.each([
    ["python3", "python"],
    ["Python", "python"],
    ["typescript", "typescript"],
    ["javascript", "javascript"],
    ["node", "javascript"],
    ["deno", "javascript"],
    ["R", null],
    ["julia", null],
    [undefined, null]
  ])("runs a %s notebook on %s", (language, runtime) => {
    expect(runtimeForKernelLanguage(language)).toBe(runtime);
  });
});

describe("createNotebookKernel", () => {
  it("opens nothing until a cell asks, then shares one started kernel", async () => {
    const kernel = createNotebookKernel("python3");
    expect(kernel.runtime).toBe("python");
    expect(port.opened).toEqual([]);
    const first = kernel.handle();
    expect(kernel.handle()).toBe(first);
    expect(port.opened).toHaveLength(1);
    await Promise.resolve();
    expect(port.opened[0].isStarted).toBe(true);
  });

  it("has no kernel for a language nothing can run", () => {
    const kernel = createNotebookKernel("julia");
    expect(kernel.runtime).toBeNull();
    expect(kernel.handle()).toBeNull();
    expect(port.opened).toEqual([]);
  });

  it("follows the kernel's status, and restart clears it along with the execution count", async () => {
    const kernel = createNotebookKernel("python");
    expect([kernel.phase, kernel.detail]).toEqual(["idle", ""]);
    const runtime = kernel.handle()!;
    expect([kernel.nextExecutionCount(), kernel.nextExecutionCount()]).toEqual([1, 2]);

    const run = runtime.execute({ runtime: "python", mode: "cell", files: [], entry: "cell" });
    // The scripted run-time emits running then idle; the kernel ends on the last status it heard.
    await run;
    expect(kernel.phase).toBe("idle");

    kernel.restart();
    expect(port.opened[0].restartCount).toBe(1);
    expect([kernel.phase, kernel.detail]).toEqual(["idle", ""]);
    expect(kernel.nextExecutionCount()).toBe(1);
  });

  it("reports a status with a detail, such as a restart", () => {
    const kernel = createNotebookKernel("python");
    kernel.handle();
    port.opened[0].restart();
    expect([kernel.phase, kernel.detail]).toEqual(["idle", "Run-time restarted"]);
  });

  it("runs every registered cell in order, one at a time, ignoring a second Run All while busy", async () => {
    const kernel = createNotebookKernel("python");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    kernel.register(async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
    });
    const unregister = kernel.register(async () => void order.push("b"));
    kernel.register(async () => void order.push("c"));
    unregister();
    unregister();

    const all = kernel.runAll();
    expect(kernel.busy).toBe(true);
    await kernel.runAll();
    release();
    await all;

    expect(order).toEqual(["a:start", "a:end", "c"]);
    expect(kernel.busy).toBe(false);
  });

  it("disposes the kernel and opens a fresh one on next use", () => {
    const kernel = createNotebookKernel("javascript");
    const first = kernel.handle();
    kernel.dispose();
    expect(port.opened[0].isDisposed).toBe(true);
    expect(kernel.handle()).not.toBe(first);
    expect(port.opened).toHaveLength(2);
    kernel.dispose();
    // With no kernel open, dispose and restart have nothing to act on.
    expect(() => {
      kernel.dispose();
      kernel.restart();
    }).not.toThrow();
  });
});
