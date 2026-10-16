-- The Insights context's reads (PR F of the learning plan): store-postgres's InsightsRead. Insights
-- write nothing (Rule 0410); they read the rows of the Assistance and Feedback contexts through
-- these three views, never the tables. Each view is the rows' facts without their free text: no
-- student name, no hint, no annotation or reflection body, so nothing written to one student can
-- reach a page of numbers. The numbers themselves (ranks, medians, percentiles and their
-- withholding for a small cohort) are computed in @tutors/domain/insights, not in SQL.
--
-- Every read names a course and a half-open period, and each has an index that leads with the
-- course and the time it filters on (Rule 0417); assistance_requests already has
-- idx_assistance_requests_course_time.

CREATE OR REPLACE VIEW insights_help_requests AS
  SELECT id, course_id, lab_route, step_id, learner_id, kind, state, requested_at,
         acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, helped
  FROM assistance_requests;

CREATE OR REPLACE VIEW insights_annotations AS
  SELECT id, course_id, lab_route, step_id, anchor_kind, anchor_id, audience, learner_id, author_id, created_at, revoked_at
  FROM feedback_annotations;

CREATE OR REPLACE VIEW insights_reflections AS
  SELECT id, course_id, lab_route, step_id, learner_id, kind, shared_at
  FROM feedback_reflections;

CREATE INDEX IF NOT EXISTS idx_feedback_annotations_course_time
  ON feedback_annotations (course_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_reflections_course_time
  ON feedback_reflections (course_id, shared_at);
