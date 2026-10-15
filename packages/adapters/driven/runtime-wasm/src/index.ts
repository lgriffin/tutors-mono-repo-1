/**
 * `@tutors/runtime-wasm`: the CodeRuntimePort adapter. Student code runs in an iframe carrying
 * `sandbox="allow-scripts"` and nothing else, served from `/runtimes/runtime-host.html` by the
 * reader; inside it a worker hosts the engines (Pyodide, the TypeScript compiler, the browser's
 * own JavaScript). The frame's origin is opaque, so the code can reach neither the reader's
 * storage nor its session; the token on every message is what makes the channel trustworthy.
 */
export { DEFAULT_TIMEOUT_MS, Kernel, wasmCodeRuntime, type KernelOptions } from "./kernel.ts";
