<script lang="ts">
  /**
   * A toast for the educator when a student shares a snippet (issue #155). The ping carries no
   * snippet data (it crosses a topic any student may join), so the toast says only that something
   * was shared and points at the authorised dashboard for the detail.
   */
  import { noticeService } from "@tutors/svelte-state/community";
  import { toaster, BROADCAST_TOAST_DURATION } from "@tutors/ui-primitives/utils/toaster";
  import { t } from "@tutors/i18n";

  interface Props {
    /** The course this dashboard is for; a change rebinds the subscription. */
    courseId: string;
  }

  let { courseId }: Props = $props();

  function showSnippetToast() {
    toaster.create({
      type: "info",
      title: t("classTime.snippetsNew"),
      description: t("classTime.snippetsNewHint"),
      duration: BROADCAST_TOAST_DURATION,
      meta: { actionUrl: `/${courseId}/gists`, actionLabel: t("classTime.snippetsOpen") }
    });
  }

  $effect(() => {
    const id = courseId.trim();
    if (!id) return;
    return noticeService.onSnippetShared(id, showSnippetToast);
  });
</script>
