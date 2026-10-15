<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { onDestroy } from "svelte";
  import { prefersReducedMotion } from "@tutors/a11y";
  import { t } from "@tutors/i18n";
  import { currentNotebookCellIndex } from "@tutors/svelte-state";
  import { createNotebookKernel, setNotebookKernel, type NotebookService } from "@tutors/svelte-state/course";
  import { currentCodeTheme } from "@tutors/svelte-state/markdown";
  import { sanitizeHtml } from "@tutors/ui-primitives/utils/sanitize";
  import { copyCode } from "@tutors/svelte-state/markdown";
  import NotebookCell from "./cells/NotebookCell.svelte";
  import "./notebook-styles.css";

  interface Props {
    notebook: NotebookService;
  }
  let { notebook }: Props = $props();

  // One kernel for the notebook, handed to the cells through context. Nothing is
  // downloaded until a cell is actually run.
  // Course JSON published before the generator recorded a kernel has none; such notebooks were always Python.
  const kernel = createNotebookKernel(notebook.notebook.kernelLanguage || "python");
  setNotebookKernel(kernel);

  /** How far below the top of the view a cell still counts as the one being read, in pixels. */
  const HEADING_REACHED_TOP = 120;

  let loaded = false;
  const activeIndex = $derived(notebook.activeCellIndex);
  let revealedOutputs = $state<Record<number, boolean>>({});
  let revealedSolutions = $state<Record<number, boolean>>({});

  function toggleOutput(index: number) {
    revealedOutputs[index] = !revealedOutputs[index];
  }

  function toggleSolution(index: number) {
    revealedSolutions[index] = !revealedSolutions[index];
  }

  function scrollToCell(index: number) {
    const el = document.getElementById(`notebook-cell-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: prefersReducedMotion.value ? "auto" : "smooth", block: "start" });
    }
  }

  function handleCellClick(index: number) {
    notebook.setActiveCell(index);
    document.getElementById(`notebook-cell-${index}`)?.focus({ preventScroll: true });
    scrollToCell(index);
  }

  /**
   * The course navigation marks the outline entry for the cell being read. It is a sibling of this page
   * rather than a parent, so the cell reaches it through a rune.
   *
   * The cell being read is the last outlined one whose top has reached the top of the reading area. Each
   * cell is looked up and measured afresh on every pass: the reading column remounts its cells under
   * {#key}, so an element held from an earlier pass can be one that has since left the page.
   *
   * The listener captures, because it is the reading column that scrolls here, not the window.
   */
  $effect(() => {
    const outlined = notebook.outline.map(entry => entry.index);
    let pending = 0;
    const update = () => {
      let current = outlined[0] ?? 0;
      for (const index of outlined) {
        const cell = document.getElementById(`notebook-cell-${index}`);
        if (cell && cell.getBoundingClientRect().top <= HEADING_REACHED_TOP) current = index;
      }
      currentNotebookCellIndex.value = current;
    };
    // One measurement per frame: a scroll fires far more often than the page paints.
    const schedule = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; update(); });
    };
    update();
    addEventListener("scroll", schedule, { capture: true, passive: true });
    addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(pending);
      removeEventListener("scroll", schedule, { capture: true });
      removeEventListener("resize", schedule);
    };
  });

  // Selecting a cell from the outline or the pager marks it straight away, rather than waiting for the
  // scroll it starts to settle.
  $effect(() => {
    currentNotebookCellIndex.value = notebook.outline.findLast(entry => entry.index <= activeIndex)?.index ?? activeIndex;
  });

  onDestroy(() => kernel.dispose());

  afterNavigate(() => {
    if (!loaded) {
      loaded = true;
      return;
    }
    const elemPage = document.querySelector("#notebook-panel");
    if (elemPage && window.innerWidth >= 600) {
      elemPage.scrollIntoView({ behavior: prefersReducedMotion.value ? "auto" : "smooth", block: "start" });
    }
  });
</script>

<svelte:head>
  <!--
    Served from here rather than from a CDN, like the code run-times: the reader's content
    security policy allows stylesheets from itself, and a maths-heavy notebook should not
    depend on a third-party host being reachable. `pnpm runtimes:sync` puts it there.
  -->
  <link rel="stylesheet" href="/runtimes/katex/katex.min.css" />
</svelte:head>

<div class="notebook-content w-full">
  <div class="grid min-w-0 gap-4">
    <!-- The outline is in the course navigation (CourseNavigation.svelte), beside a lab's steps. -->
    <!-- Main content area -->
    <div class="min-w-0 flex-1 reading-panel" use:copyCode>
      <div id="notebook-panel" class="notebook-cells mt-[-60px] block pt-[60px]">
        {#if kernel.runtime}
          <div class="bg-surface-100 dark:bg-surface-800 border-surface-200 dark:border-surface-700 mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <button class="bg-surface-200 dark:bg-surface-700 hover:bg-surface-300 dark:hover:bg-surface-600 rounded-md px-3 py-1 text-xs font-medium disabled:opacity-50" onclick={() => kernel.runAll()} disabled={kernel.busy}>
              {t("notebook.runAll")}
            </button>
            <button class="bg-surface-200 dark:bg-surface-700 hover:bg-surface-300 dark:hover:bg-surface-600 rounded-md px-3 py-1 text-xs font-medium" onclick={() => kernel.restart()}>
              {t("notebook.restartKernel")}
            </button>
            <div class="flex-1"></div>
            <span class="text-surface-500 text-xs" aria-live="polite">{kernel.detail || kernel.phase}</span>
          </div>
        {/if}
        {#key currentCodeTheme.value}
          {#each notebook.cells as cell, i}
            <NotebookCell
              {cell}
              index={i}
              {notebook}
              isActive={activeIndex === i}
              outputRevealed={revealedOutputs[i] ?? false}
              solutionRevealed={revealedSolutions[i] ?? false}
              onToggleOutput={() => toggleOutput(i)}
              onToggleSolution={() => toggleSolution(i)}
              onClick={() => notebook.setActiveCell(i)}
              kernelLanguage={notebook.notebook.kernelLanguage}
            />
          {/each}
        {/key}
      </div>
    </div>
  </div>

  <nav aria-label="Notebook cell navigation" class="ui-actions mt-4 justify-between">
    <button class="ui-button" disabled={activeIndex <= 0} onclick={() => handleCellClick(activeIndex - 1)}>Previous cell</button>
    <span class="ui-muted cell-count">Cell {activeIndex + 1} of {notebook.cells.length}</span>
    <button class="ui-button" disabled={activeIndex >= notebook.cells.length - 1} onclick={() => handleCellClick(activeIndex + 1)}>Next cell</button>
  </nav>
</div>
<style>
  .notebook-cells { max-width: min(88ch, calc(var(--reading-width) + 16ch)); margin-inline: auto; }
  .cell-count { font-size: var(--font-label); }
</style>
