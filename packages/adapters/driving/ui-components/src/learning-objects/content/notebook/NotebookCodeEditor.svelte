<script lang="ts">
  /**
   * An editable, runnable notebook cell.
   *
   * It runs on the notebook's kernel rather than one of its own, so a cell can use what an
   * earlier cell defined. The engine is loaded on first run — opening a notebook downloads
   * nothing — and the code executes in a sandboxed frame, which is what allows this to work
   * under the reader's content security policy at all.
   */
  import { onMount } from "svelte";
  import { t } from "@tutors/i18n";
  import type { RuntimeEvent } from "@tutors/application/ports";
  import CodeEditor from "../code/CodeEditor.svelte";
  import { getNotebookKernel } from "@tutors/svelte-state/course";
  import "./notebook-styles.css";

  interface Props {
    source: string;
    language?: string;
  }
  let { source, language = "python" }: Props = $props();

  const notebookKernel = getNotebookKernel();

  let code = $state(source);
  let output = $state("");
  let hasRun = $state(false);
  let isRunning = $state(false);
  let executionCount = $state<number | null>(null);
  let failed = $state(false);

  const editorLanguage = $derived(language === "javascript" || language === "typescript" ? language : "python");
  const runtimeName = $derived(editorLanguage === "javascript" ? "JavaScript" : editorLanguage === "typescript" ? "TypeScript" : "Python");
  const runnable = $derived(notebookKernel?.runtime !== null && notebookKernel?.runtime !== undefined);

  function handleEvent(event: RuntimeEvent, id: string) {
    if (event.type !== "stream" && event.type !== "result" && event.type !== "error") return;
    if (event.id !== id) return;
    if (event.type === "stream") output += event.text;
    if (event.type === "result" && event.value) output += `${event.value}\n`;
    if (event.type === "error" && event.message) output += `${event.message}\n`;
  }

  async function runCode() {
    const kernel = notebookKernel?.handle();
    if (!kernel || isRunning) return;

    isRunning = true;
    hasRun = true;
    failed = false;
    output = "";
    executionCount = notebookKernel?.nextExecutionCount() ?? null;

    const id = `cell-${executionCount}-${Math.random().toString(36).slice(2, 8)}`;
    // Every cell hears everything the kernel says, so this one listens for its own run and
    // stops listening the moment that run is over.
    const unsubscribe = kernel.subscribe((event) => handleEvent(event, id));
    try {
      const result = await kernel.execute({ id, runtime: notebookKernel!.runtime!, mode: "cell", files: [{ path: "cell", content: code }], entry: "cell" });
      failed = !result.ok;
    } finally {
      unsubscribe();
      isRunning = false;
    }
  }

  function resetCode() {
    code = source;
    output = "";
    hasRun = false;
    failed = false;
    executionCount = null;
  }

  // Registering returns the way to unregister, which is what onMount does with a callback.
  onMount(() => notebookKernel?.register(runCode));
</script>

<div class="notebook-editor">
  <CodeEditor value={code} language={editorLanguage} label={`${language} exercise code`} onChange={(value) => (code = value)} onRun={runCode} />
</div>

<div class="ui-actions exercise-actions" aria-busy={isRunning}>
  {#if runnable}
    <button class="ui-button ui-button-primary" onclick={runCode} disabled={isRunning}>
      {#if isRunning}
        <span class="animate-spin text-sm" aria-hidden="true">&#9696;</span>
        {notebookKernel?.detail || t("playground.running")}
      {:else}
        <span aria-hidden="true">&#9654;</span>
        {t("playground.run")}
      {/if}
    </button>

    {#if hasRun}
      <button class="ui-button" disabled={isRunning} onclick={resetCode}>
        {t("playground.reset")}
      </button>
      <span class="font-mono text-xs text-[var(--ui-muted)]">[{executionCount ?? " "}]</span>
    {/if}
  {:else}
    <span class="text-xs text-[var(--ui-muted)]">{t("notebook.notRunnable")}</span>
  {/if}
</div>

{#if hasRun && output}
  <div class="notebook-outputs exercise-output" role="status" aria-label={`${runtimeName} output`}>
    <pre class="font-mono text-sm whitespace-pre-wrap {failed ? 'text-[var(--ui-danger)]' : ''}">{output}</pre>
  </div>
{/if}

<style>
  .exercise-actions, .exercise-output { padding: var(--space-3); border-top: 1px solid var(--ui-border); background: var(--ui-surface); }
</style>
