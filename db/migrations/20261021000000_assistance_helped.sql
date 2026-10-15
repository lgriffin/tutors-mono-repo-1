-- Whether a help request helped (the Assistance context, PR C of the learning plan): once a request
-- is resolved, the reader asks the student once whether it helped and the reader's server records
-- the answer on the request (Rule 0398). Null until the student answers.

ALTER TABLE assistance_requests ADD COLUMN IF NOT EXISTS helped BOOLEAN;

-- A student's own latest request in a course: the reader shows a lecturer's hint and asks whether
-- it helped from it after the request has left the queue.
CREATE INDEX IF NOT EXISTS idx_assistance_requests_learner_latest
  ON assistance_requests (course_id, learner_id, requested_at DESC);
