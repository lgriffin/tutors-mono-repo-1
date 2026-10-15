<script lang="ts">
  /** A lecturer's message to every student reading the course right now (issue #78). */
  import { noticeService } from "@tutors/svelte-state/community";
  import { currentCourse, tutorsId } from "@tutors/svelte-state";
  import { t } from "@tutors/i18n";

  const course = $derived(currentCourse.value);
  let title = $state("");
  let description = $state("");
  let actionUrl = $state("");
  let actionLabel = $state("");
  let sending = $state(false);
  let feedback = $state<{ kind: "sent" | "limited"; message: string } | null>(null);

  function reset() {
    title = "";
    description = "";
    actionUrl = "";
    actionLabel = "";
  }

  async function onSubmit(event: Event) {
    event.preventDefault();
    const courseId = course?.courseId;
    if (!courseId || sending) return;
    sending = true;
    const senderName = tutorsId.value?.name || tutorsId.value?.login || "Tutor";
    const sent = await noticeService.sendLecturerBroadcast(
      courseId,
      { title: title.trim(), description: description.trim(), actionUrl: actionUrl.trim() || undefined, actionLabel: actionLabel.trim() || undefined },
      senderName
    );
    sending = false;
    if (!sent) {
      feedback = { kind: "limited", message: t("broadcast.limitedHint") };
      return;
    }
    feedback = { kind: "sent", message: t("broadcast.sentMessage") };
    reset();
  }
</script>

{#if feedback}
  <div role="status" class="feedback" class:limited={feedback.kind === "limited"}>{feedback.message}</div>
{/if}

<form class="space-y-3 p-2" onsubmit={onSubmit}>
  <p class="ui-muted info-text">{t("broadcast.subtitle")}</p>

  <div>
    <label class="label mb-1 font-semibold" for="broadcast-title">{t("broadcast.fieldTitle")}</label>
    <input id="broadcast-title" class="input w-full rounded-sm" type="text" placeholder={t("broadcast.fieldTitlePlaceholder")} maxlength={80} bind:value={title} required />
  </div>

  <div>
    <label class="label mb-1 font-semibold" for="broadcast-desc">{t("broadcast.fieldDescription")}</label>
    <textarea id="broadcast-desc" class="input w-full rounded-sm min-h-[3rem]" rows="2" placeholder={t("broadcast.fieldDescriptionPlaceholder")} maxlength={280} bind:value={description} required></textarea>
  </div>

  <details>
    <summary class="ui-muted mt-2 cursor-pointer info-text">{t("broadcast.fieldActionUrl")}</summary>
    <div class="mt-2 space-y-2">
      <input class="input w-full rounded-sm" type="text" aria-label={t("broadcast.fieldActionUrl")} placeholder={t("broadcast.fieldActionUrlPlaceholder")} bind:value={actionUrl} />
      <input class="input w-full rounded-sm" type="text" aria-label={t("broadcast.fieldActionLabel")} placeholder={t("broadcast.fieldActionLabelPlaceholder")} maxlength={24} bind:value={actionLabel} />
      <p class="ui-muted info-text">{t("broadcast.fieldActionUrlHint")}</p>
    </div>
  </details>

  <div class="flex justify-end pt-1">
    <button class="ui-button ui-button-primary" type="submit" disabled={sending}>{t("broadcast.send")}</button>
  </div>
</form>

<style>
  .info-text { font-size: var(--font-label); }
  .feedback { margin-bottom: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); background: var(--ui-selected); font-size: var(--font-label); }
  .feedback.limited { color: var(--ui-danger); }
</style>
