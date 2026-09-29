export class ContextControllerError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 503,
    readonly code:
      | "context_request_invalid"
      | "context_access_denied"
      | "context_not_found"
      | "context_source_limit_exceeded"
      | "context_budget_exceeded"
      | "context_view_stale"
      | "context_view_consumed"
      | "context_operation_busy"
      | "context_source_invalid"
      | "context_version_conflict"
      | "context_materialization_too_large"
      | "no_eligible_runtime_active"
      | "idempotency_conflict"
      | "context_subsystem_degraded"
      | "request_digest_mismatch"
      | "measurement_stale",
    message: string,
  ) {
    super(message);
    this.name = "ContextControllerError";
  }
}
