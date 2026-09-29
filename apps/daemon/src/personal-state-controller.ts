import {
  PERSONAL_STATE_CONTRACT_VERSION,
  personalStateDigest,
  personalStateSubjectDigest,
  type CanonicalMeasurementReceipt,
  type CanonicalMeasurementRequest,
  type ContextPlanItem,
  type ContextViewOmission,
  type ForgetOperation,
  type ForgetRequest,
  type PersonalStateCapability,
  type PersonalStateScope,
  type PersonalStateViewRequest,
  type PersonalStateViewReceipt,
  type SourceProvisionReceipt,
} from "@larm/core";
import type {
  LlamaContextSlotEraseAdapter,
  LocalContextSourceStore,
  LocalInferenceAuditStore,
  LocalPersonalStateJournal,
  LlamaContextTokenizer,
} from "@larm/backends";
import {
  ContextController,
  ContextControllerError,
  publicContextView,
} from "./context-controller";
import { PersonalStateForgetCoordinator } from "./personal-state-forget";
import { PersonalStateAttemptLifecycle } from "./personal-state-attempt-lifecycle";
import { PersonalStateSourceCoordinator } from "./personal-state-source-coordinator";
import { PersonalStateMeasurement } from "./personal-state-measurement";
import { PersonalStateControllerError } from "./personal-state-controller-errors";

export { PersonalStateControllerError } from "./personal-state-controller-errors";

const ALL_SCOPES: PersonalStateScope[] = [
  "context.source.provision",
  "context.measure",
  "context.view.create",
  "context.generate",
  "context.attempt.cancel",
  "context.forget",
  "context.operation.read",
];

type PersonalStateControllerOptions = {
  enabled: boolean;
  journal: LocalPersonalStateJournal;
  context: ContextController;
  sourceStore: LocalContextSourceStore;
  tokenizer: LlamaContextTokenizer;
  auditStore?: LocalInferenceAuditStore;
  slotAdapter?: LlamaContextSlotEraseAdapter;
  sourceMaxBytes: number;
  sourceMaxTotalBytes: number;
  receiptTtlMs: number;
  quarantineRuntime?: (runtime: string) => void;
  clearRuntimeQuarantine?: (runtime: string) => void;
  now?: () => number;
};

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class PersonalStateController {
  private readonly attemptLifecycle: PersonalStateAttemptLifecycle;
  private readonly forgetCoordinator: PersonalStateForgetCoordinator;
  private readonly sourceCoordinator: PersonalStateSourceCoordinator;
  private readonly measurementCoordinator: PersonalStateMeasurement;
  private mutationChain = Promise.resolve();

  constructor(private readonly options: PersonalStateControllerOptions) {
    this.sourceCoordinator = new PersonalStateSourceCoordinator({
      journal: options.journal,
      context: options.context,
      sourceStore: options.sourceStore,
      tokenizer: options.tokenizer,
      sourceMaxBytes: options.sourceMaxBytes,
      sourceMaxTotalBytes: options.sourceMaxTotalBytes,
      receiptTtlMs: options.receiptTtlMs,
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      serialized: (operation) => this.serialized(operation),
    });
    this.measurementCoordinator = new PersonalStateMeasurement({
      enabled: options.enabled,
      journal: options.journal,
      context: options.context,
      receiptTtlMs: options.receiptTtlMs,
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      serialized: (operation) => this.serialized(operation),
    });
    this.attemptLifecycle = new PersonalStateAttemptLifecycle({
      journal: options.journal,
      context: options.context,
      slotAdapter: options.slotAdapter,
      quarantineRuntime: options.quarantineRuntime,
      clearRuntimeQuarantine: options.clearRuntimeQuarantine,
      isoNow: () => this.isoNow(),
      serialized: (operation) => this.serialized(operation),
    });
    this.forgetCoordinator = new PersonalStateForgetCoordinator({
      journal: options.journal,
      context: options.context,
      sourceStore: options.sourceStore,
      auditStore: options.auditStore,
      slotAdapter: options.slotAdapter,
      receiptTtlMs: options.receiptTtlMs,
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      cancelAttempt: (subjectDigest, attemptId) => this.attemptLifecycle.cancelInternal(subjectDigest, attemptId),
      isAttemptNotFound: (error) =>
        error instanceof PersonalStateControllerError && error.code === "personal_state_not_found",
      waitForAttemptTerminal: (subjectDigest, attemptId, timeoutMs) =>
        this.attemptLifecycle.waitForTerminal(subjectDigest, attemptId, timeoutMs),
      confirmRuntimeStopped: (runtime) => this.attemptLifecycle.confirmRuntimeStopped(runtime),
      quarantineRuntime: options.quarantineRuntime,
      clearRuntimeQuarantine: options.clearRuntimeQuarantine,
    });
  }

  async initialize(): Promise<void> {
    await this.options.journal.initialize();
    const snapshot = await this.options.journal.snapshot();
    const now = this.isoNow();
    for (const attempt of snapshot.attempts) {
      const recovered = attempt.state === "accepted" || attempt.state === "forwarded"
        ? await this.options.journal.saveAttempt({
          ...attempt,
          state: "result_unknown",
          stopState: "stop_unknown",
          outcome: "daemon_restarted",
          terminalAt: now,
          updatedAt: now,
        })
        : attempt;
      if (["cancel_requested", "transport_closed", "stop_unknown"].includes(recovered.stopState)) {
        this.options.quarantineRuntime?.(recovered.runtime);
      }
    }
    await this.options.journal.prune(this.now());
  }

  async capability(input: {
    principal: string;
    allocationId: string;
    runtime: string;
    credentialExpiresAt: string;
  }): Promise<PersonalStateCapability> {
    this.assertEnabled();
    const binding = this.options.context.productRuntimeBinding(input.allocationId, input.runtime);
    return {
      contractVersion: PERSONAL_STATE_CONTRACT_VERSION,
      bootEpoch: await this.options.journal.bootEpoch(),
      subjectDigest: personalStateSubjectDigest(input.principal),
      allocationId: input.allocationId,
      runtime: input.runtime,
      release: binding.release,
      leaseEpoch: binding.leaseEpoch,
      leaseExpiresAt: binding.leaseExpiresAt,
      credentialExpiresAt: input.credentialExpiresAt,
      tokenizerDigest: binding.tokenizerDigest,
      chatTemplateDigest: binding.chatTemplateDigest,
      contextLimitTokens: binding.contextLimitTokens,
      outputReserveTokens: binding.outputReserveTokens,
      safetyMarginTokens: binding.safetyMarginTokens,
      sourceTokenLimit: binding.sourceTokenLimit,
      maxSourceBytes: this.options.sourceMaxBytes,
      maxTotalSourceBytes: this.options.sourceMaxTotalBytes,
      maxMaterializedBytes: binding.materializedMaxBytes,
      scopes: ALL_SCOPES,
    };
  }

  async provision(input: {
    principal: string;
    incarnation: string;
    allocationId: string;
    runtime: string;
    sourceDigest: string;
    content: string;
  }): Promise<{ receipt: SourceProvisionReceipt; replay: boolean }> {
    this.assertEnabled();
    return await this.sourceCoordinator.provision(input);
  }

  async provisionReceipt(principal: string, incarnation: string): Promise<SourceProvisionReceipt> {
    return await this.sourceCoordinator.provisionReceipt(principal, incarnation);
  }

  async registerContext(input: {
    principal: string;
    allocationId: string;
    request: import("@larm/core").ContextRegistrationRequest;
    idempotencyKey: string;
  }): Promise<Awaited<ReturnType<ContextController["register"]>>> {
    this.assertEnabled();
    return await this.sourceCoordinator.registerContext(input);
  }

  async measure(
    principal: string,
    request: CanonicalMeasurementRequest,
  ): Promise<{ receipt: CanonicalMeasurementReceipt; replay: boolean }> {
    return await this.measurementCoordinator.measure(principal, request);
  }

  async measurementReceipt(principal: string, id: string): Promise<CanonicalMeasurementReceipt> {
    return await this.measurementCoordinator.receipt(principal, id);
  }

  async createView(
    principal: string,
    request: PersonalStateViewRequest,
    idempotencyKey: string,
  ): Promise<{ view: ReturnType<typeof publicContextView>; replay: boolean }> {
    this.assertEnabled();
    return await this.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(principal);
      const planDigest = personalStateDigest({
        measurementId: request.measurementId,
        allocationId: request.allocationId,
        runtime: request.runtime,
        maxInputTokens: request.maxInputTokens,
        deadline: request.deadline,
        requestDigest: personalStateDigest(request.request),
        items: [...request.items].sort((left, right) =>
          compareCanonicalText(left.contextId, right.contextId)
          || compareCanonicalText(left.version, right.version)
        ),
      });
      const idempotencyKeyDigest = personalStateDigest({ subjectDigest, idempotencyKey });
      const keyReceipt = await this.options.journal.viewByIdempotencyKeyDigest(
        subjectDigest,
        idempotencyKeyDigest,
      );
      if (
        keyReceipt
        && (keyReceipt.viewRequestId !== request.viewRequestId || keyReceipt.planDigest !== planDigest)
      ) {
        throw new PersonalStateControllerError(
          409,
          "request_digest_mismatch",
          "idempotency key is already bound to another view request",
        );
      }
      const existingView = await this.options.journal.view(subjectDigest, request.viewRequestId);
      if (existingView) {
        if (
          existingView.planDigest !== planDigest
          || existingView.idempotencyKeyDigest !== idempotencyKeyDigest
        ) {
          throw new PersonalStateControllerError(
            409,
            "request_digest_mismatch",
            "view request ID is already bound to another plan",
          );
        }
        const currentBoot = await this.options.journal.bootEpoch();
        const active = existingView.bootEpoch === currentBoot
          ? this.options.context.getView(principal, existingView.viewId)
          : undefined;
        if (active) return { view: active, replay: true };
        throw new PersonalStateControllerError(
          410,
          "measurement_stale",
          "the prior view result is durable but its one-shot credential is no longer active",
        );
      }
      const receipt = await this.options.journal.measurement(subjectDigest, request.measurementId);
      const requestDigest = personalStateDigest(request.request);
      if (!receipt || Date.parse(receipt.expiresAt) <= this.now()) {
        throw new PersonalStateControllerError(410, "measurement_stale", "measurement is unavailable or expired");
      }
      if (
        receipt.requestDigest !== requestDigest
        || receipt.allocationId !== request.allocationId
        || receipt.runtime !== request.runtime
      ) {
        throw new PersonalStateControllerError(409, "request_digest_mismatch", "request does not match measurement");
      }
      const dataEpoch = await this.options.journal.currentEpoch(subjectDigest);
      const binding = this.options.context.productRuntimeBinding(request.allocationId, request.runtime);
      if (
        receipt.dataEpoch !== dataEpoch
        || receipt.release !== binding.release
        || receipt.leaseEpoch !== binding.leaseEpoch
        || receipt.tokenizerDigest !== binding.tokenizerDigest
        || receipt.chatTemplateDigest !== binding.chatTemplateDigest
      ) {
        throw new PersonalStateControllerError(409, "measurement_stale", "measurement identity is stale");
      }
      const required = request.items.filter((item) => item.required)
        .sort((left, right) =>
          compareCanonicalText(left.contextId, right.contextId)
          || compareCanonicalText(left.version, right.version)
        );
      const optional = request.items.filter((item) => !item.required)
        .sort((left, right) =>
          right.utility - left.utility
          || compareCanonicalText(left.contextId, right.contextId)
          || compareCanonicalText(left.version, right.version)
        );
      const selected: ContextPlanItem[] = [...required];
      const omitted: ContextViewOmission[] = [];
      const budget = Math.min(request.maxInputTokens, receipt.maxInputTokens);
      let actualInputTokens = receipt.baseInputTokens;
      if (required.length > 0) {
        const measured = await this.options.context.measureCanonicalRequest({
          principal,
          allocationId: request.allocationId,
          runtime: request.runtime,
          request: request.request,
          items: required,
        });
        actualInputTokens = measured.inputTokens;
        if (actualInputTokens > budget) {
          throw new PersonalStateControllerError(422, "personal_state_request_invalid", "required context exceeds budget");
        }
      }
      for (const item of optional) {
        const trial = [...selected, item];
        try {
          const measured = await this.options.context.measureCanonicalRequest({
            principal,
            allocationId: request.allocationId,
            runtime: request.runtime,
            request: request.request,
            items: trial,
          });
          if (measured.inputTokens <= budget) {
            selected.push(item);
            actualInputTokens = measured.inputTokens;
          } else {
            omitted.push({ contextId: item.contextId, version: item.version, reason: "budget" });
          }
        } catch (error) {
          if (
            error instanceof ContextControllerError
            && (error.code === "context_not_found" || error.code === "context_source_invalid")
          ) {
            omitted.push({
              contextId: item.contextId,
              version: item.version,
              reason: error.code === "context_not_found" ? "not_found" : "invalid",
            });
            continue;
          }
          throw error;
        }
      }
      if (selected.length === 0) {
        throw new PersonalStateControllerError(422, "personal_state_request_invalid", "no context fits the budget");
      }
      await this.options.journal.assertEpoch(subjectDigest, dataEpoch);
      const created = await this.options.context.createView({
        allocationId: request.allocationId,
        runtime: request.runtime,
        baseInputTokens: receipt.baseInputTokens,
        maxInputTokens: budget,
        deadline: request.deadline,
        canonicalizationVersion: "context-view-v1",
        items: selected.map((item) => ({ ...item, required: true })),
      }, principal, `ps-${personalStateDigest({ subjectDigest, viewRequestId: request.viewRequestId, planDigest }).slice(0, 64)}`);
      const view = await this.options.context.bindPersonalStateView({
        principal,
        viewId: created.view.id,
        requestDigest,
        dataEpoch,
        actualInputTokens,
        selectedItems: selected,
        omitted,
      });
      await this.options.journal.saveView({
        contractVersion: PERSONAL_STATE_CONTRACT_VERSION,
        viewRequestId: request.viewRequestId,
        subjectDigest,
        requestDigest,
        planDigest,
        idempotencyKeyDigest,
        viewId: view.id,
        operationId: view.operationId,
        allocationId: view.allocationId,
        runtime: view.runtime,
        release: view.release,
        bootEpoch: await this.options.journal.bootEpoch(),
        dataEpoch,
        dependencies: {
          contextIds: [...new Set(view.orderedItems.map((item) => item.contextId))].sort(),
          sourceDigests: [...new Set(view.orderedItems.map((item) => item.sourceDigest))].sort(),
        },
        state: view.state,
        createdAt: view.createdAt,
        updatedAt: view.createdAt,
        expiresAt: view.expiresAt,
      });
      return { view, replay: created.replay };
    });
  }

  async viewReceipt(principal: string, id: string): Promise<PersonalStateViewReceipt> {
    const receipt = await this.options.journal.view(personalStateSubjectDigest(principal), id);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "view receipt not found");
    return receipt;
  }

  async beginAttempt(input: {
    principal: string;
    attemptId: string;
    allocationId: string;
    runtime: string;
    release: string;
    viewId?: string;
    request: Record<string, unknown>;
  }) {
    this.assertEnabled();
    return await this.attemptLifecycle.beginAttempt(input);
  }

  async markAttemptForwarded(subjectDigest: string, attemptId: string): Promise<void> {
    await this.attemptLifecycle.markForwarded(subjectDigest, attemptId);
  }

  async finishAttempt(input: {
    subjectDigest: string;
    attemptId: string;
    succeeded: boolean;
    cancelled: boolean;
    transportClosed?: boolean;
    outcome: string;
  }): Promise<void> {
    await this.attemptLifecycle.finish(input);
  }

  async attemptReceipt(principal: string, attemptId: string) {
    return await this.attemptLifecycle.receipt(principal, attemptId);
  }

  async cancelAttempt(principal: string, attemptId: string) {
    return await this.attemptLifecycle.cancel(principal, attemptId);
  }

  async forget(principal: string, request: ForgetRequest): Promise<{ operation: ForgetOperation; replay: boolean }> {
    return await this.serialized(async () => await this.forgetCoordinator.run(principal, request));
  }

  async forgetReceipt(principal: string, forgetId: string): Promise<ForgetOperation> {
    const receipt = await this.options.journal.forget(personalStateSubjectDigest(principal), forgetId);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "forget operation not found");
    return receipt;
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new PersonalStateControllerError(503, "personal_state_disabled", "Personal State delivery is disabled");
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
