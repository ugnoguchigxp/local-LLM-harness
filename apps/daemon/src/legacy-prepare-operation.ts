import { getRuntime, type Registry } from "@larm/core";
import { LifecycleError, type RuntimeBackend } from "@larm/backends";
import type { Observer } from "./observer";
import type { Operation } from "./controller";

export async function runLegacyPrepareOperation(input: {
  operation: Operation;
  abort: AbortController;
  registry: Registry;
  backend: RuntimeBackend;
  observer: Pick<Observer, "tick">;
  isoNow: () => string;
  deleteAbortedOperation: (operationId: string) => void;
  clearOperationAbort: (operationId: string, abort: AbortController) => void;
  pruneHistory: () => void;
}): Promise<void> {
  const { operation, abort } = input;
  if (abort.signal.aborted) {
    operation.status = "cancelled";
    operation.ready = false;
    operation.completedAt = input.isoNow();
    operation.error = {
      code: "operation_cancelled",
      message: abort.signal.reason instanceof Error
        ? abort.signal.reason.message
        : "operation cancelled",
    };
    input.deleteAbortedOperation(operation.id);
    input.pruneHistory();
    return;
  }
  operation.status = "running";
  try {
    for (const runtimeId of operation.ensure) {
      if (abort.signal.aborted) throw abort.signal.reason;
      const runtime = getRuntime(input.registry, runtimeId);
      if (!runtime) throw new Error(`runtime ${runtimeId} disappeared from registry`);
      await input.backend.ensure(runtime, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      await input.observer.tick();
      if (abort.signal.aborted) throw abort.signal.reason;
    }
    operation.status = "succeeded";
    operation.ready = true;
    operation.completedAt = input.isoNow();
  } catch (error) {
    operation.status = abort.signal.aborted ? "cancelled" : "failed";
    operation.ready = false;
    operation.completedAt = input.isoNow();
    if (abort.signal.aborted) {
      operation.error = {
        code: "operation_cancelled",
        message: abort.signal.reason instanceof Error
          ? abort.signal.reason.message
          : "operation cancelled",
      };
    } else if (error instanceof LifecycleError) {
      operation.error = { code: error.code, message: error.message };
    } else {
      operation.error = {
        code: "start_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    input.clearOperationAbort(operation.id, abort);
    input.pruneHistory();
  }
}
