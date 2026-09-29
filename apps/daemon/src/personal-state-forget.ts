import {
  personalStateOperationId,
  personalStateSubjectDigest,
  type ForgetOperation,
  type ForgetPhaseName,
  type ForgetRequest,
  type GenerationAttempt,
} from "@larm/core";
import type {
  LlamaContextSlotEraseAdapter,
  LocalContextSourceStore,
  LocalInferenceAuditStore,
  LocalPersonalStateJournal,
} from "@larm/backends";
import type { ContextController } from "./context-controller";
import { invalidatePersonalStateContext } from "./personal-state-context-invalidation";

export type PersonalStateForgetDependencies = {
  journal: LocalPersonalStateJournal;
  context: ContextController;
  sourceStore: LocalContextSourceStore;
  auditStore?: LocalInferenceAuditStore;
  slotAdapter?: LlamaContextSlotEraseAdapter;
  receiptTtlMs: number;
  now: () => number;
  isoNow: () => string;
  cancelAttempt: (subjectDigest: string, attemptId: string) => Promise<GenerationAttempt>;
  isAttemptNotFound: (error: unknown) => boolean;
  waitForAttemptTerminal: (subjectDigest: string, attemptId: string, timeoutMs: number) => Promise<boolean>;
  confirmRuntimeStopped: (runtime: string) => Promise<void>;
  quarantineRuntime?: (runtime: string) => void;
  clearRuntimeQuarantine?: (runtime: string) => void;
};

export class PersonalStateForgetCoordinator {
  constructor(private readonly dependencies: PersonalStateForgetDependencies) {}

  async run(
    principal: string,
    request: ForgetRequest,
  ): Promise<{ operation: ForgetOperation; replay: boolean }> {
    const d = this.dependencies;
    const subjectDigest = personalStateSubjectDigest(principal);
    const now = d.isoNow();
    const begun = await d.journal.beginForget({
      subjectDigest,
      request,
      operationId: personalStateOperationId("forget", subjectDigest, request.forgetId),
      now,
      expiresAt: new Date(d.now() + d.receiptTtlMs).toISOString(),
    });
    if (begun.operation.state === "succeeded") return begun;
    let operation: ForgetOperation = {
      ...begun.operation,
      state: "running",
      updatedAt: d.isoNow(),
    };
    await d.journal.saveForget(operation);
    const provision = request.incarnation
      ? await d.journal.provision(subjectDigest, request.incarnation)
      : undefined;
    const sourceHandles = new Set([
      ...request.sourceHandles,
      ...(begun.operation.resolved?.sourceHandles ?? []),
    ]);
    if (provision) sourceHandles.add(provision.sourceHandle);
    let invalidated: Awaited<ReturnType<ContextController["invalidatePersonalState"]>> = {
      descriptors: [],
      viewIds: [...(begun.operation.resolved?.viewIds ?? [])],
      sourceDigests: [...(begun.operation.resolved?.sourceDigests ?? [])],
    };
    let invalidationCompleted = false;

    operation = await this.runPhase(operation, "attempts", async () => {
      let affected = 0;
      let stopUnknown = false;
      for (const attemptId of request.attemptIds) {
        try {
          const attempt = await d.cancelAttempt(subjectDigest, attemptId);
          affected += 1;
          if (attempt.stopState === "stop_unknown") stopUnknown = true;
          if (!await d.waitForAttemptTerminal(subjectDigest, attemptId, 15_000)) {
            stopUnknown = true;
          }
        } catch (error) {
          if (!d.isAttemptNotFound(error)) throw error;
        }
      }
      return { affected, stopUnknown };
    });
    operation = await this.runPhase(operation, "views", async () => {
      invalidated = await invalidatePersonalStateContext({
        context: d.context,
        journal: d.journal,
        principal,
        subjectDigest,
        forgetId: request.forgetId,
        request,
        sourceHandles,
        initial: {
          ...invalidated,
          sourceDigests: [
            ...invalidated.sourceDigests,
            ...(provision ? [provision.sourceDigest] : []),
          ],
        },
        nowIso: () => d.isoNow(),
      });
      invalidationCompleted = true;
      return { affected: invalidated.viewIds.length };
    });
    operation = await this.runPhase(operation, "runtime", async () => {
      if (!invalidationCompleted && (request.contextIds.length > 0 || sourceHandles.size > 0)) {
        throw new Error("runtime_dependencies_unresolved");
      }
      const attempts = await d.journal.attemptsFor(subjectDigest, request.attemptIds);
      const invalidatedViewIds = new Set(invalidated.viewIds);
      const views = (await d.journal.viewsForSubject(subjectDigest))
        .filter((view) => invalidatedViewIds.has(view.viewId));
      const candidateRuntimes = new Set([
        ...attempts.map((attempt) => attempt.runtime),
        ...views.map((view) => view.runtime),
        ...(provision ? [provision.runtime] : []),
      ]);
      const endpoints = new Map<string, Set<string>>();
      for (const runtime of candidateRuntimes) {
        const endpoint = d.context.personalStateCleanupEndpoint(runtime);
        if (!endpoint) {
          d.quarantineRuntime?.(runtime);
          throw new Error("runtime_cleanup_endpoint_unavailable");
        }
        const runtimes = endpoints.get(endpoint) ?? new Set<string>();
        runtimes.add(runtime);
        endpoints.set(endpoint, runtimes);
      }
      if (endpoints.size === 0) {
        for (const attempt of attempts.filter((item) => item.stopState === "stop_unknown")) {
          await d.journal.saveAttempt({
            ...attempt,
            stopState: "backend_stopped",
            backendStoppedAt: d.isoNow(),
            updatedAt: d.isoNow(),
          });
          d.clearRuntimeQuarantine?.(attempt.runtime);
        }
        return { affected: 0 };
      }
      if (!d.slotAdapter) {
        for (const runtimes of endpoints.values()) {
          for (const runtime of runtimes) d.quarantineRuntime?.(runtime);
        }
        return { affected: 0, stopUnknown: true };
      }
      let affected = 0;
      let stopUnknown = false;
      for (const endpoint of endpoints.keys()) {
        try {
          await d.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
          for (const runtime of endpoints.get(endpoint)!) {
            await d.confirmRuntimeStopped(runtime);
            d.clearRuntimeQuarantine?.(runtime);
          }
          affected += 1;
        } catch {
          stopUnknown = true;
          for (const runtime of endpoints.get(endpoint)!) d.quarantineRuntime?.(runtime);
        }
      }
      return { affected, stopUnknown };
    });
    operation = await this.runPhase(operation, "snapshots", async () => {
      if (!invalidationCompleted) throw new Error("snapshot_absence_unverified");
      return { affected: invalidated.viewIds.length };
    });
    operation = await this.runPhase(operation, "registry", async () => {
      if (!invalidationCompleted) throw new Error("registry_absence_unverified");
      return { affected: invalidated.descriptors.length };
    });
    operation = await this.runPhase(operation, "sources", async () => {
      for (const handle of sourceHandles) await d.sourceStore.delete(principal, handle);
      const absence = await Promise.all([...sourceHandles].map((handle) =>
        d.sourceStore.absent(principal, handle)
      ));
      if (absence.some((value) => !value)) throw new Error("source_absence_unverified");
      return { affected: sourceHandles.size };
    });
    operation = await this.runPhase(operation, "audit", async () => {
      if (!invalidationCompleted && (request.contextIds.length > 0 || sourceHandles.size > 0)) {
        throw new Error("audit_dependencies_unresolved");
      }
      if (!d.auditStore) return { affected: 0 };
      const result = await d.auditStore.erasePersonalState({
        subjectDigest,
        attemptIds: request.attemptIds,
        viewIds: invalidated.viewIds,
        sourceDigests: invalidated.sourceDigests,
      });
      return { affected: result.removed, stopUnknown: result.active > 0 };
    });
    const complete = Object.values(operation.phases).every((phase) => phase.state === "absent");
    const unresolvedPhase = Object.entries(operation.phases)
      .find(([, phase]) => phase.state !== "absent");
    const overallError = unresolvedPhase?.[1].state === "stop_unknown"
      ? "remote_stop_unknown"
      : unresolvedPhase
      ? `forget_${unresolvedPhase[0]}_${unresolvedPhase[1].state}`
      : "forget_absence_unverified";
    operation = {
      ...operation,
      state: complete ? "succeeded" : "result_unknown",
      absenceVerified: complete,
      updatedAt: d.isoNow(),
      ...(complete ? { completedAt: d.isoNow() } : { error: overallError }),
    };
    if (complete) delete operation.error;
    operation = await d.journal.saveForget(operation);
    return { operation, replay: begun.replay };
  }

  private async runPhase(
    operation: ForgetOperation,
    phase: ForgetPhaseName,
    run: () => Promise<{ affected: number; stopUnknown?: boolean }>,
  ): Promise<ForgetOperation> {
    const d = this.dependencies;
    const running: ForgetOperation = {
      ...operation,
      phases: {
        ...operation.phases,
        [phase]: { state: "running", affected: 0, updatedAt: d.isoNow() },
      },
      updatedAt: d.isoNow(),
    };
    await d.journal.saveForget(running);
    try {
      const result = await run();
      const latest = await d.journal.forget(operation.subjectDigest, operation.forgetId) ?? running;
      const updated: ForgetOperation = {
        ...latest,
        phases: {
          ...latest.phases,
          [phase]: {
            state: result.stopUnknown ? "stop_unknown" : "absent",
            affected: result.affected,
            updatedAt: d.isoNow(),
          },
        },
        updatedAt: d.isoNow(),
      };
      return await d.journal.saveForget(updated);
    } catch (error) {
      const latest = await d.journal.forget(operation.subjectDigest, operation.forgetId) ?? running;
      const updated: ForgetOperation = {
        ...latest,
        phases: {
          ...latest.phases,
          [phase]: {
            state: "failed",
            affected: 0,
            updatedAt: d.isoNow(),
            error: error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code).slice(0, 128)
              : "phase_failed",
          },
        },
        updatedAt: d.isoNow(),
      };
      return await d.journal.saveForget(updated);
    }
  }
}
