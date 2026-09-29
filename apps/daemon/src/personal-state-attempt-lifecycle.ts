import { randomUUID } from "node:crypto";
import {
  PERSONAL_STATE_CONTRACT_VERSION,
  personalStateDigest,
  personalStateSubjectDigest,
  type GenerationAttempt,
} from "@larm/core";
import type {
  LlamaContextSlotEraseAdapter,
  LocalPersonalStateJournal,
} from "@larm/backends";
import type { ContextController } from "./context-controller";
import { PersonalStateControllerError } from "./personal-state-controller-errors";

type AttemptKey = `${string}\0${string}`;

export type PersonalStateAttemptLifecycleOptions = {
  journal: LocalPersonalStateJournal;
  context: Pick<
    ContextController,
    "productRuntimeBinding" | "viewPersonalStateBinding" | "personalStateCleanupEndpoint"
  >;
  slotAdapter?: LlamaContextSlotEraseAdapter;
  quarantineRuntime?: (runtime: string) => void;
  clearRuntimeQuarantine?: (runtime: string) => void;
  isoNow: () => string;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>;
};

export class PersonalStateAttemptLifecycle {
  private readonly abortControllers = new Map<AttemptKey, AbortController>();
  private readonly terminalWaiters = new Map<AttemptKey, {
    promise: Promise<void>;
    resolve: () => void;
  }>();

  constructor(private readonly options: PersonalStateAttemptLifecycleOptions) {}

  async beginAttempt(input: {
    principal: string;
    attemptId: string;
    allocationId: string;
    runtime: string;
    release: string;
    viewId?: string;
    request: Record<string, unknown>;
  }): Promise<{ attempt: GenerationAttempt; signal: AbortSignal; replay: boolean }> {
    return await this.options.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(input.principal);
      const requestDigest = personalStateDigest(input.request);
      if (await this.options.journal.isForgotten({ subjectDigest, attemptId: input.attemptId })) {
        throw new PersonalStateControllerError(409, "forget_in_progress", "generation attempt is tombstoned");
      }
      const existing = await this.options.journal.attempt(subjectDigest, input.attemptId);
      if (existing) {
        if (
          existing.requestDigest !== requestDigest
          || existing.allocationId !== input.allocationId
          || existing.runtime !== input.runtime
          || existing.viewId !== input.viewId
        ) {
          throw new PersonalStateControllerError(409, "request_digest_mismatch", "attempt ID is already in use");
        }
        throw new PersonalStateControllerError(
          409,
          "personal_state_request_invalid",
          `attempt already exists in ${existing.state} state; query its receipt`,
        );
      }
      const binding = this.options.context.productRuntimeBinding(input.allocationId, input.runtime);
      if (binding.release !== input.release) {
        throw new PersonalStateControllerError(409, "measurement_stale", "attempt release is stale");
      }
      const viewBinding = input.viewId
        ? this.options.context.viewPersonalStateBinding(input.principal, input.viewId)
        : undefined;
      if (input.viewId && (!viewBinding || viewBinding.requestDigest !== requestDigest)) {
        throw new PersonalStateControllerError(409, "request_digest_mismatch", "attempt request does not match view");
      }
      const dataEpoch = await this.options.journal.currentEpoch(subjectDigest);
      if (viewBinding && viewBinding.dataEpoch !== dataEpoch) {
        throw new PersonalStateControllerError(409, "measurement_stale", "view data epoch is stale");
      }
      const now = this.options.isoNow();
      const attempt: GenerationAttempt = {
        contractVersion: PERSONAL_STATE_CONTRACT_VERSION,
        attemptId: input.attemptId,
        subjectDigest,
        allocationId: input.allocationId,
        runtime: input.runtime,
        release: input.release,
        ...(input.viewId ? { viewId: input.viewId } : {}),
        requestDigest,
        larmRequestId: `req_${randomUUID()}`,
        dataEpoch,
        state: "accepted",
        stopState: "not_requested",
        createdAt: now,
        updatedAt: now,
      };
      await this.options.journal.saveAttempt(attempt);
      if (input.viewId) {
        const viewReceipt = await this.options.journal.viewByViewId(subjectDigest, input.viewId);
        if (viewReceipt) {
          await this.options.journal.saveView({
            ...viewReceipt,
            state: "consumed",
            updatedAt: this.options.isoNow(),
          });
        }
      }
      const controller = new AbortController();
      const key = this.attemptKey(subjectDigest, input.attemptId);
      this.abortControllers.set(key, controller);
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.terminalWaiters.set(key, { promise, resolve });
      return { attempt, signal: controller.signal, replay: false };
    });
  }

  async markForwarded(subjectDigest: string, attemptId: string): Promise<void> {
    const attempt = await this.options.journal.attempt(subjectDigest, attemptId);
    if (!attempt || attempt.state !== "accepted") return;
    const now = this.options.isoNow();
    await this.options.journal.saveAttempt({ ...attempt, state: "forwarded", forwardedAt: now, updatedAt: now });
  }

  async finish(input: {
    subjectDigest: string;
    attemptId: string;
    succeeded: boolean;
    cancelled: boolean;
    transportClosed?: boolean;
    outcome: string;
  }): Promise<void> {
    const attempt = await this.options.journal.attempt(input.subjectDigest, input.attemptId);
    if (!attempt) return;
    const key = this.attemptKey(input.subjectDigest, input.attemptId);
    this.abortControllers.delete(key);
    const now = this.options.isoNow();
    const wasCancelled = attempt.stopState !== "not_requested" || input.cancelled;
    let stopState = input.transportClosed && attempt.stopState !== "backend_stopped"
      ? attempt.forwardedAt ? "transport_closed" as const : "backend_stopped" as const
      : attempt.stopState;
    let backendStoppedAt = attempt.backendStoppedAt;
    let cleanupConfirmed = false;
    if (input.transportClosed && !attempt.forwardedAt) {
      backendStoppedAt = this.options.isoNow();
    } else if (input.transportClosed && stopState !== "backend_stopped") {
      try {
        const endpoint = this.options.context.personalStateCleanupEndpoint(attempt.runtime);
        if (!endpoint || !this.options.slotAdapter) throw new Error("runtime cleanup unavailable");
        await this.options.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
        stopState = "backend_stopped";
        backendStoppedAt = this.options.isoNow();
        cleanupConfirmed = true;
      } catch {
        stopState = "stop_unknown";
        this.options.quarantineRuntime?.(attempt.runtime);
      }
    }
    await this.options.journal.saveAttempt({
      ...attempt,
      state: wasCancelled ? "cancelled" : input.succeeded ? "completed" : "failed",
      stopState,
      ...(input.transportClosed ? { transportClosedAt: now } : {}),
      ...(backendStoppedAt ? { backendStoppedAt } : {}),
      terminalAt: now,
      updatedAt: now,
      outcome: input.outcome.slice(0, 128) || "unknown",
    });
    if (cleanupConfirmed) {
      try {
        await this.confirmRuntimeStopped(attempt.runtime);
        this.options.clearRuntimeQuarantine?.(attempt.runtime);
      } catch {
        this.options.quarantineRuntime?.(attempt.runtime);
      }
    }
    this.terminalWaiters.get(key)?.resolve();
    this.terminalWaiters.delete(key);
  }

  async receipt(principal: string, attemptId: string): Promise<GenerationAttempt> {
    const receipt = await this.options.journal.attempt(personalStateSubjectDigest(principal), attemptId);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "attempt not found");
    return receipt;
  }

  async cancel(principal: string, attemptId: string): Promise<GenerationAttempt> {
    return await this.options.serialized(async () =>
      await this.cancelInternal(personalStateSubjectDigest(principal), attemptId)
    );
  }

  async cancelInternal(subjectDigest: string, attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.options.journal.attempt(subjectDigest, attemptId);
    if (!attempt) throw new PersonalStateControllerError(404, "personal_state_not_found", "attempt not found");
    if (
      attempt.state === "completed"
      || attempt.state === "failed"
      || (attempt.state === "cancelled" && attempt.stopState !== "stop_unknown")
    ) return attempt;
    const now = this.options.isoNow();
    this.abortControllers.get(this.attemptKey(subjectDigest, attemptId))?.abort(new Error("generation cancelled"));
    attempt = await this.options.journal.saveAttempt({
      ...attempt,
      state: "cancelled",
      stopState: "cancel_requested",
      cancelRequestedAt: now,
      updatedAt: now,
      terminalAt: now,
      outcome: "cancel_requested",
    });
    if (!this.options.slotAdapter) {
      this.options.quarantineRuntime?.(attempt.runtime);
      return await this.options.journal.saveAttempt({ ...attempt, stopState: "stop_unknown", updatedAt: this.options.isoNow() });
    }
    try {
      const endpoint = this.options.context.personalStateCleanupEndpoint(attempt.runtime);
      if (!endpoint) throw new Error("runtime cleanup endpoint is unavailable");
      await this.options.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
      const stopped = await this.options.journal.saveAttempt({
        ...attempt,
        stopState: "backend_stopped",
        backendStoppedAt: this.options.isoNow(),
        updatedAt: this.options.isoNow(),
        outcome: "backend_stopped",
      });
      await this.confirmRuntimeStopped(attempt.runtime);
      this.options.clearRuntimeQuarantine?.(attempt.runtime);
      return stopped;
    } catch {
      this.options.quarantineRuntime?.(attempt.runtime);
      return await this.options.journal.saveAttempt({
        ...attempt,
        stopState: "stop_unknown",
        updatedAt: this.options.isoNow(),
        outcome: "remote_stop_unknown",
      });
    }
  }

  async waitForTerminal(subjectDigest: string, attemptId: string, timeoutMs: number): Promise<boolean> {
    const waiter = this.terminalWaiters.get(this.attemptKey(subjectDigest, attemptId));
    if (!waiter) return true;
    return await Promise.race([
      waiter.promise.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  async confirmRuntimeStopped(runtime: string): Promise<void> {
    const now = this.options.isoNow();
    const ambiguous = (await this.options.journal.snapshot()).attempts.filter((attempt) =>
      attempt.runtime === runtime
      && attempt.stopState !== "not_requested"
      && attempt.stopState !== "backend_stopped"
    );
    for (const attempt of ambiguous) {
      await this.options.journal.saveAttempt({
        ...attempt,
        stopState: "backend_stopped",
        backendStoppedAt: now,
        updatedAt: now,
      });
    }
  }

  private attemptKey(subjectDigest: string, attemptId: string): AttemptKey {
    return `${subjectDigest}\0${attemptId}`;
  }
}
