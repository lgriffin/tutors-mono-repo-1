-- Lecturer feedback and shared reflections (the Feedback context, PR E of the learning plan):
-- store-postgres's FeedbackStore. Only the reader's server writes them, as the signed-in actor
-- (POST /api/feedback); no Supabase table is added for them.
--
-- An annotation is anchored to exactly one thing at a step (the step itself, a shared snippet or a
-- shared reflection) and addressed to one student or to everyone on the step; one for everyone is a
-- broadcast (Rule 0400). A revoked annotation is kept with its revocation time for the review
-- history (Rule 0406). A reflection is a copy of a note a student chose to share (Rule 0384).

CREATE TABLE IF NOT EXISTS feedback_annotations (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id   TEXT NOT NULL,
  lab_route   TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('step', 'snippet', 'reflection')),
  anchor_id   TEXT,
  audience    TEXT NOT NULL CHECK (audience IN ('student', 'everyone')),
  learner_id  TEXT,
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  author_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  CHECK ((anchor_kind = 'step') = (anchor_id IS NULL)),
  CHECK ((audience = 'everyone') = (learner_id IS NULL))
);

-- A step's annotations: what a student on the step reads, in one query (Rule 0403).
CREATE INDEX IF NOT EXISTS idx_feedback_annotations_step
  ON feedback_annotations (course_id, lab_route, step_id);

-- What a student received in a course (Rule 0409): theirs, and the course's broadcasts.
CREATE INDEX IF NOT EXISTS idx_feedback_annotations_learner
  ON feedback_annotations (course_id, learner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_annotations_broadcasts
  ON feedback_annotations (course_id, created_at DESC)
  WHERE audience = 'everyone';

CREATE TABLE IF NOT EXISTS feedback_reflections (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id   TEXT NOT NULL,
  lab_route   TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  learner_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  shared_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_reflections_step
  ON feedback_reflections (course_id, lab_route, step_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reflections_learner
  ON feedback_reflections (course_id, learner_id);
