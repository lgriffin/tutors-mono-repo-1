<script lang="ts">
  /**
   * The annotations a lecturer addressed to this student at this lab step, under its content
   * (Rule 0403): on the step itself, on a snippet they shared or on a reflection they shared. Another
   * student's never reach this browser. Bodies are markdown, rendered and sanitised as lab content is
   * (Rule 0408).
   */
  import { feedbackService } from "@tutors/svelte-state/feedback/step";
  import type { Annotation } from "@tutors/domain/feedback";
  import { sanitizeHtml } from "@tutors/ui-primitives/utils/sanitize";
  import { t } from "@tutors/i18n";

  const cards = $derived(feedbackService.available.value ? feedbackService.view.value.personal : []);
  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const anchorLabel = (a: Annotation) => t(a.anchor.kind === "snippet" ? "feedback.onSnippet" : a.anchor.kind === "reflection" ? "feedback.onReflection" : "feedback.onStep");
</script>

{#if cards.length}
  <section class="feedback-cards" aria-labelledby="feedback-cards-title">
    <h2 id="feedback-cards-title" class="ui-label">{t("feedback.forYou")}</h2>
    {#each cards as card (card.id)}
      <article class="feedback-card ui-panel" data-anchor={card.anchor.kind}>
        <p class="ui-eyebrow">{anchorLabel(card)}</p>
        <div class="feedback-body prose dark:prose-invert">{@html sanitizeHtml(feedbackService.render(card.body))}</div>
        <p class="feedback-meta ui-muted">{t("feedback.from")} {card.authorId} · <time datetime={card.createdAt}>{when(card.createdAt)}</time></p>
      </article>
    {/each}
  </section>
{/if}

<style>
  .feedback-cards {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }
  .feedback-card {
    padding: var(--space-3) var(--space-4);
    border-inline-start: 3px solid var(--ui-success);
  }
  .feedback-body {
    margin-top: var(--space-2);
    max-width: none;
    overflow-wrap: anywhere;
  }
  .feedback-meta {
    margin-top: var(--space-2);
    font-size: var(--font-caption);
  }
</style>
