export class PersonalStateControllerError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 413 | 422 | 503,
    readonly code:
      | "personal_state_disabled"
      | "personal_state_request_invalid"
      | "personal_state_access_denied"
      | "personal_state_not_found"
      | "incarnation_conflict"
      | "measurement_stale"
      | "request_digest_mismatch"
      | "forget_in_progress"
      | "remote_stop_unknown"
      | "personal_state_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PersonalStateControllerError";
  }
}
