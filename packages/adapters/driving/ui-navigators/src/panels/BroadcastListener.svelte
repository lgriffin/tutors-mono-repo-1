<script lang="ts">
  /**
   * Shows a lecturer's broadcast to a student as a toast (issue #78). Mounted once per course page;
   * the subscription follows the course on screen.
   */
  import { currentCourse } from "@tutors/svelte-state";
  import { noticeService } from "@tutors/svelte-state/community";
  import type { LecturerBroadcast } from "@tutors/application/ports";
  import { toaster, BROADCAST_TOAST_DURATION } from "@tutors/ui-primitives/utils/toaster";
  import { t } from "@tutors/i18n";

  function showBroadcast(broadcast: LecturerBroadcast) {
    const sender = broadcast.senderName && broadcast.senderName !== "Anon" ? broadcast.senderName : null;
    const title = sender ? `${sender}: ${t("broadcast.receivedToast")}` : t("broadcast.receivedToast");
    const description = [broadcast.title, broadcast.description].filter(Boolean).join(" — ");
    toaster.create({
      type: "info",
      title,
      description,
      duration: BROADCAST_TOAST_DURATION,
      meta: {
        actionUrl: broadcast.actionUrl,
        actionLabel: broadcast.actionLabel ?? t("broadcast.actionDefault")
      }
    });
  }

  $effect(() => {
    const courseId = currentCourse.value?.courseId;
    if (!courseId) return;
    return noticeService.onLecturerBroadcast(courseId, showBroadcast);
  });
</script>
