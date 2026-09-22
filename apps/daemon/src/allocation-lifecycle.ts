export class AllocationLifecycleError extends Error {
  constructor(
    readonly code: "foreground_preempted",
    message: string,
    readonly status = 409,
    readonly retryAfterSeconds = 1,
  ) {
    super(message);
    this.name = "AllocationLifecycleError";
  }
}
