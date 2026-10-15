<script lang="ts">
  /**
   * A signed-in student's "share a snippet with my tutor" (issue #155): a floating button on a
   * course page and the dialog behind it. The snippet goes to the reader's server, which keeps it
   * for 48 hours for the course's educators and pings their dashboards.
   */
  import { Dialog, Portal } from "@skeletonlabs/skeleton-svelte";
  import Icon from "@tutors/ui-primitives/components/Icon.svelte";
  import { t } from "@tutors/i18n";
  import { currentCourse, currentLo, tutorsId } from "@tutors/svelte-state";
  import { snippetService } from "@tutors/svelte-state/community";
  import { toaster } from "@tutors/ui-primitives/utils/toaster";

  let open = $state(false);
  let filename = $state("");
  let title = $state("");
  let content = $state("");
  let creating = $state(false);
  let errorMessage = $state<string | null>(null);

  const bytes = $derived(snippetService.bytesOf(content));
  const tooLarge = $derived(bytes > snippetService.maxBytes);
  const canShare = $derived(!creating && content.trim().length > 0 && !tooLarge);
  const kb = (n: number) => `${(n / 1000).toFixed(n < 100 ? 1 : 0)} KB`;

  /** The learning object the snippet is filed against: what the tutor sees. */
  const attachedTo = $derived(currentLo.value?.title ?? "");

  /** The button, but only for a signed-in student in a loaded course of a reader that can keep snippets. */
  const show = $derived(snippetService.enabled() && !!tutorsId.value?.login && !!currentCourse.value?.courseId);

  function reset() {
    const lo = currentLo.value;
    filename = lo ? lo.title.replace(/[^\w.-]+/g, "_").slice(0, 60) + ".txt" : "snippet.txt";
    title = lo?.title ?? "";
    content = "";
    errorMessage = null;
  }

  async function submit() {
    if (creating) return;
    if (!content.trim()) {
      errorMessage = t("gist.contentRequired");
      return;
    }
    if (tooLarge) {
      errorMessage = t("gist.tooLarge");
      return;
    }
    const login = tutorsId.value?.login;
    const courseId = currentCourse.value?.courseId;
    if (!login || !courseId) return;
    creating = true;
    errorMessage = null;
    const lo = currentLo.value;
    const outcome = await snippetService.share(
      { courseId, filename: filename.trim() || "snippet.txt", content, title: title.trim(), loRoute: lo?.route ?? "", loTitle: lo?.title ?? "" },
      { login, name: tutorsId.value?.name ?? null }
    );
    creating = false;
    if (!outcome.ok) {
      errorMessage = outcome.message ?? t("gist.error");
      toaster.create({ type: "error", title: t("gist.error"), description: outcome.message ?? undefined });
      return;
    }
    open = false;
    toaster.create({ type: "success", title: t("gist.success"), description: t("gist.successMessage") });
  }
</script>

{#if show}
  <div class="share-snippet">
    <button
      type="button"
      class="ui-button ui-button-primary share-button"
      onclick={() => {
        reset();
        open = true;
      }}
      aria-haspopup="dialog"
    >
      <Icon type="note" height="18" />
      {t("gist.button")}
    </button>
  </div>

  <Dialog {open} onOpenChange={(details) => (open = details.open)} closeOnInteractOutside={false} closeOnEscape={true}>
    <Portal>
      <Dialog.Backdrop class="fixed inset-0 z-50 bg-surface-50-950/50 backdrop-blur-sm" />
      <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <Dialog.Content class="ui-panel flex max-h-[85vh] w-full max-w-2xl flex-col shadow-xl">
          <header class="flex items-start justify-between gap-4 border-b border-[var(--ui-border)] p-4">
            <div class="min-w-0">
              <Dialog.Title class="ui-title">{t("gist.modalTitle")}</Dialog.Title>
              <p class="ui-muted mt-0.5 text-xs">{t("gist.modalSubtitle")}</p>
              {#if attachedTo}
                <p class="ui-muted mt-0.5 truncate text-xs">{t("gist.attachedTo")} <span class="font-medium">{attachedTo}</span></p>
              {/if}
            </div>
            <button type="button" class="shrink-0 rounded-lg p-1" aria-label={t("gist.close")} onclick={() => (open = false)}>
              <Icon type="close" height="20" />
            </button>
          </header>

          <div class="flex-1 space-y-3 overflow-y-auto p-4">
            <!-- Content leads: the student is here to paste an error, not to name a file. The other two
                 fields are prefilled from the learning object and fold away below. -->
            <div>
              <div class="mb-1 flex items-baseline justify-between">
                <label class="label font-semibold" for="gist-content">{t("gist.content")}</label>
                <span class="text-xs" class:text-[var(--ui-danger)]={tooLarge}>{kb(bytes)} / {kb(snippetService.maxBytes)}</span>
              </div>
              <textarea id="gist-content" class="input h-64 w-full resize-y rounded-sm font-mono text-sm" bind:value={content} placeholder={t("gist.contentPlaceholder")}></textarea>
            </div>

            <details>
              <summary class="ui-muted cursor-pointer text-sm">{t("gist.details")}</summary>
              <div class="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <label class="label mb-1 text-sm" for="gist-filename">{t("gist.filename")}</label>
                  <input id="gist-filename" class="input w-full rounded-sm" bind:value={filename} placeholder={t("gist.filenamePlaceholder")} />
                </div>
                <div>
                  <label class="label mb-1 text-sm" for="gist-title">{t("gist.description")}</label>
                  <input id="gist-title" class="input w-full rounded-sm" bind:value={title} placeholder={t("gist.descriptionPlaceholder")} />
                </div>
              </div>
            </details>

            <!-- Who sees this, and for how long, is the most consequential line in the dialog. -->
            <div class="warn flex gap-2 rounded-lg p-3">
              <span class="shrink-0"><Icon type="lock" height="18" /></span>
              <p class="text-xs">{t("gist.warn")}</p>
            </div>

            {#if errorMessage}
              <p role="alert" class="text-sm text-[var(--ui-danger)]">{errorMessage}</p>
            {/if}
          </div>

          <footer class="flex justify-end gap-2 border-t border-[var(--ui-border)] p-4">
            <button type="button" class="ui-button" onclick={() => (open = false)}>{t("gist.cancel")}</button>
            <button type="button" class="ui-button ui-button-primary" disabled={!canShare} onclick={submit}>{creating ? t("gist.creating") : t("gist.share")}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Portal>
  </Dialog>
{/if}

<style>
  .share-snippet { position: fixed; right: var(--space-6); bottom: var(--space-6); z-index: 40; }
  .share-button { display: inline-flex; align-items: center; gap: var(--space-2); border-radius: 999px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.2); }
  .warn { background: var(--ui-selected); }
</style>
