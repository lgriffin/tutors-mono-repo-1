export { loadContentLocks, setContentLock, type ContentLocksDeps } from "./content-locks.ts";
export { courseAdmission, type Admission } from "./admission.ts";
export { createAuthorization, listFromEnv, AuthorizationUnavailableError, type Authorization, type AuthorizationDeps, type Actor as AuthorizationActor, type Resource } from "./authorization.ts";
