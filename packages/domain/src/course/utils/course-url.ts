/**
 * Where a course id's published `tutors.json` is served.
 *
 * A course id is one of three things and they are not distinguishable by shape alone, so the
 * order of these checks is the contract:
 *
 *   - `localhost:5173` / `192.168.0.5:5173`: a locally served course, over http.
 *   - `course.example.com` / `https://course.example.com`: a self-hosted course, over https.
 *   - `cs101-2025`: a bare id, which Tutors publishes to Netlify.
 *
 * Assuming the last case unconditionally is what made local and self-hosted courses invisible to
 * anything that reads `tutors.json` on a server: the fetch resolved to
 * `https://localhost:5173.netlify.app`, failed, and the caller saw the same result as a course that
 * genuinely has no such file.
 */

/**
 * Trailing `/` stripped by scanning, not by `/\/+$/`: the course id reaches here from a URL
 * parameter, and that regex backtracks quadratically on a long run of slashes.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

export function courseJsonUrl(courseId: string): string {
  const id = courseId.trim();
  const isLocal = id.startsWith("localhost") || id.startsWith("192");
  const isDomain = /^(https?:\/\/)?([A-Za-z0-9-]+\.)+[A-Za-z]{2,}(:[0-9]+)?(\/.*)?$/.test(id);

  if (isLocal) return `http://${stripTrailingSlashes(id)}/tutors.json`;
  if (isDomain) {
    const withScheme = /^https?:\/\//.test(id) ? id : `https://${id}`;
    return `${stripTrailingSlashes(withScheme)}/tutors.json`;
  }
  return `https://${id}.netlify.app/tutors.json`;
}
