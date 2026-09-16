import { createHash, randomUUID } from "node:crypto";
import {
  PERSONAL_STATE_CONTRACT_VERSION,
  personalStateDigest,
  personalStateOperationId,
  personalStateSourceHandle,
  personalStateSubjectDigest,
  type CanonicalMeasurementReceipt,
  type CanonicalMeasurementRequest,
  type ContextRegistrationRequest,
  type ContextPlanItem,
  type ContextViewOmission,
  type ForgetOperation,
  type ForgetPhaseName,
  type ForgetRequest,
  type GenerationAttempt,
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

const ALL_SCOPES: PersonalStateScope[] = [
  "context.source.provision",
  "context.measure",
  "context.view.create",
  "context.generate",
  "context.attempt.cancel",
  "context.forget",
  "context.operation.read",
];

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

type AttemptKey = `${string}\0${string}`;

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class PersonalStateController {
  private readonly abortControllers = new Map<AttemptKey, AbortController>();
  private readonly terminalWaiters = new Map<AttemptKey, {
    promise: Promise<void>;
    resolve: () => void;
  }>();
  private mutationChain = Promise.resolve();

  constructor(private readonly options: PersonalStateControllerOptions) {}

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
    return await this.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(input.principal);
      const encoded = new TextEncoder().encode(input.content);
      if (encoded.byteLength === 0) {
        throw new PersonalStateControllerError(400, "personal_state_request_invalid", "source must not be empty");
      }
      if (encoded.byteLength > this.options.sourceMaxBytes) {
        throw new PersonalStateControllerError(413, "personal_state_request_invalid", "source exceeds the byte limit");
      }
      if (createHash("sha256").update(encoded).digest("hex") !== input.sourceDigest) {
        throw new PersonalStateControllerError(400, "personal_state_request_invalid", "source digest does not match content");
      }
      const existing = await this.options.journal.provision(subjectDigest, input.incarnation);
      if (existing) {
        if (
          existing.sourceDigest !== input.sourceDigest
          || existing.allocationId !== input.allocationId
          || existing.runtime !== input.runtime
        ) {
          throw new PersonalStateControllerError(
            409,
            "incarnation_conflict",
            "source incarnation is already bound to different immutable content",
          );
        }
      }
      if (await this.options.journal.isForgotten({ subjectDigest, incarnation: input.incarnation })) {
        throw new PersonalStateControllerError(409, "forget_in_progress", "source incarnation is tombstoned");
      }
      if (existing?.state === "succeeded") return { receipt: existing, replay: true };
      const binding = this.options.context.productRuntimeBinding(input.allocationId, input.runtime);
      const dataEpoch = await this.options.journal.currentEpoch(subjectDigest);
      let tokenCount: number;
      try {
        tokenCount = await this.options.tokenizer.countSourceTokens(
          binding.endpoint,
          input.content,
          AbortSignal.timeout(Math.min(binding.operationTimeoutMs, 60_000)),
        );
      } catch {
        throw new PersonalStateControllerError(
          503,
          "personal_state_unavailable",
          "canonical source tokenization failed",
        );
      }
      if (!Number.isSafeInteger(tokenCount) || tokenCount < 1 || tokenCount > binding.sourceTokenLimit) {
        throw new PersonalStateControllerError(
          422,
          "personal_state_request_invalid",
          `canonical source token count must be from 1 through ${binding.sourceTokenLimit}`,
        );
      }
      const bytes = encoded.byteLength;
      const sourceHandle = personalStateSourceHandle({
        subjectDigest,
        incarnation: input.incarnation,
        sourceDigest: input.sourceDigest,
      });
      const now = this.isoNow();
      let receipt: SourceProvisionReceipt = {
        contractVersion: PERSONAL_STATE_CONTRACT_VERSION,
        operationId: personalStateOperationId("source", subjectDigest, input.incarnation),
        incarnation: input.incarnation,
        subjectDigest,
        allocationId: input.allocationId,
        runtime: input.runtime,
        release: binding.release,
        sourceHandle,
        sourceDigest: input.sourceDigest,
        byteCount: bytes,
        tokenCount,
        tokenizerDigest: binding.tokenizerDigest,
        chatTemplateDigest: binding.chatTemplateDigest,
        leaseEpoch: binding.leaseEpoch,
        dataEpoch,
        state: "running",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: new Date(this.now() + this.options.receiptTtlMs).toISOString(),
      };
      await this.options.journal.saveProvision(receipt);
      try {
        await this.options.journal.assertEpoch(subjectDigest, dataEpoch);
        const result = await this.options.sourceStore.provisionImmutable(
          input.principal,
          sourceHandle,
          input.content,
          input.sourceDigest,
          {
            maxSourceBytes: this.options.sourceMaxBytes,
            maxTotalBytes: this.options.sourceMaxTotalBytes,
            filesystemFreeFloorBytes: binding.filesystemFreeFloorBytes,
            tokenizations: [{ tokenizerDigest: binding.tokenizerDigest, tokenCount }],
          },
        );
        await this.options.journal.assertEpoch(subjectDigest, dataEpoch);
        receipt = {
          ...receipt,
          byteCount: result.bytes,
          state: "succeeded",
          updatedAt: this.isoNow(),
        };
        await this.options.journal.saveProvision(receipt);
        return { receipt, replay: result.replay || existing !== undefined };
      } catch (error) {
        receipt = {
          ...receipt,
          state: "failed",
          error: error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code).slice(0, 128)
            : "source_commit_failed",
          updatedAt: this.isoNow(),
        };
        await this.options.journal.saveProvision(receipt).catch(() => undefined);
        if (error instanceof Error && "code" in error
          && (error as { code?: string }).code === "context_source_immutable_conflict") {
          throw new PersonalStateControllerError(409, "incarnation_conflict", "immutable source conflicts");
        }
        throw new PersonalStateControllerError(503, "personal_state_unavailable", "source commit failed");
      }
    });
  }

  async provisionReceipt(principal: string, incarnation: string): Promise<SourceProvisionReceipt> {
    const receipt = await this.options.journal.provision(personalStateSubjectDigest(principal), incarnation);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "source receipt not found");
    return receipt;
  }

  async registerContext(input: {
    principal: string;
    allocationId: string;
    request: ContextRegistrationRequest;
    idempotencyKey: string;
  }): Promise<Awaited<ReturnType<ContextController["register"]>>> {
    this.assertEnabled();
    return await this.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(input.principal);
      if (
        await this.options.journal.isForgotten({ subjectDigest, contextId: input.request.id })
        || await this.options.journal.isForgotten({ subjectDigest, sourceHandle: input.request.sourceHandle })
      ) {
        throw new PersonalStateControllerError(409, "forget_in_progress", "context or source is tombstoned");
      }
      const provision = await this.options.journal.provisionBySourceHandle(
        subjectDigest,
        input.request.sourceHandle,
      );
      if (!provision || provision.state !== "succeeded") {
        throw new PersonalStateControllerError(
          404,
          "personal_state_not_found",
          "the context source has no successful provision receipt",
        );
      }
      if (provision.allocationId !== input.allocationId) {
        throw new PersonalStateControllerError(
          403,
          "personal_state_access_denied",
          "context source belongs to another allocation",
        );
      }
      if (
        provision.sourceDigest !== input.request.sourceDigest
        || provision.byteCount !== input.request.byteCount
        || provision.tokenCount !== input.request.tokenCount
        || provision.tokenizerDigest !== input.request.tokenizerDigest
      ) {
        throw new PersonalStateControllerError(
          409,
          "request_digest_mismatch",
          "context descriptor does not match its canonical provision receipt",
        );
      }
      return await this.options.context.register(input.request, input.principal, input.idempotencyKey);
    });
  }

  async measure(
    principal: string,
    request: CanonicalMeasurementRequest,
  ): Promise<{ receipt: CanonicalMeasurementReceipt; replay: boolean }> {
    this.assertEnabled();
    return await this.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(principal);
      const requestDigest = personalStateDigest(request.request);
      const existing = await this.options.journal.measurement(subjectDigest, request.measurementId);
      if (existing) {
        if (
          existing.requestDigest !== requestDigest
          || existing.allocationId !== request.allocationId
          || existing.runtime !== request.runtime
          || existing.maxInputTokens !== request.maxInputTokens
        ) {
          throw new PersonalStateControllerError(
            409,
            "request_digest_mismatch",
            "measurement ID is already bound to another request",
          );
        }
        return { receipt: existing, replay: true };
      }
      const dataEpoch = await this.options.journal.currentEpoch(subjectDigest);
      const measured = await this.options.context.measureCanonicalRequest({
        principal,
        allocationId: request.allocationId,
        runtime: request.runtime,
        request: request.request,
      });
      const inputBudgetTokens = Math.min(request.maxInputTokens, measured.inputBudgetTokens);
      if (measured.inputTokens > inputBudgetTokens) {
        throw new PersonalStateControllerError(
          422,
          "personal_state_request_invalid",
          "canonical base request exceeds its input budget",
        );
      }
      await this.options.journal.assertEpoch(subjectDigest, dataEpoch);
      const now = this.isoNow();
      const receipt: CanonicalMeasurementReceipt = {
        contractVersion: PERSONAL_STATE_CONTRACT_VERSION,
        measurementId: request.measurementId,
        subjectDigest,
        allocationId: request.allocationId,
        runtime: request.runtime,
        release: measured.release,
        requestDigest,
        baseInputTokens: measured.inputTokens,
        maxInputTokens: inputBudgetTokens,
        tokenizerDigest: measured.tokenizerDigest,
        chatTemplateDigest: measured.chatTemplateDigest,
        leaseEpoch: measured.leaseEpoch,
        dataEpoch,
        createdAt: now,
        expiresAt: new Date(this.now() + Math.min(this.options.receiptTtlMs, 15 * 60_000)).toISOString(),
      };
      await this.options.journal.saveMeasurement(receipt);
      return { receipt, replay: false };
    });
  }

  async measurementReceipt(principal: string, id: string): Promise<CanonicalMeasurementReceipt> {
    const receipt = await this.options.journal.measurement(personalStateSubjectDigest(principal), id);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "measurement not found");
    return receipt;
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
  }): Promise<{ attempt: GenerationAttempt; signal: AbortSignal; replay: boolean }> {
    this.assertEnabled();
    return await this.serialized(async () => {
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
      const now = this.isoNow();
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
            updatedAt: this.isoNow(),
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

  async markAttemptForwarded(subjectDigest: string, attemptId: string): Promise<void> {
    const attempt = await this.options.journal.attempt(subjectDigest, attemptId);
    if (!attempt || attempt.state !== "accepted") return;
    const now = this.isoNow();
    await this.options.journal.saveAttempt({ ...attempt, state: "forwarded", forwardedAt: now, updatedAt: now });
  }

  async finishAttempt(input: {
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
    const now = this.isoNow();
    const wasCancelled = attempt.stopState !== "not_requested" || input.cancelled;
    let stopState = input.transportClosed && attempt.stopState !== "backend_stopped"
      ? attempt.forwardedAt ? "transport_closed" as const : "backend_stopped" as const
      : attempt.stopState;
    let backendStoppedAt = attempt.backendStoppedAt;
    let cleanupConfirmed = false;
    if (input.transportClosed && !attempt.forwardedAt) {
      backendStoppedAt = this.isoNow();
    } else if (input.transportClosed && stopState !== "backend_stopped") {
      try {
        const endpoint = this.options.context.personalStateCleanupEndpoint(attempt.runtime);
        if (!endpoint || !this.options.slotAdapter) throw new Error("runtime cleanup unavailable");
        await this.options.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
        stopState = "backend_stopped";
        backendStoppedAt = this.isoNow();
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

  async attemptReceipt(principal: string, attemptId: string): Promise<GenerationAttempt> {
    const receipt = await this.options.journal.attempt(personalStateSubjectDigest(principal), attemptId);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "attempt not found");
    return receipt;
  }

  async cancelAttempt(principal: string, attemptId: string): Promise<GenerationAttempt> {
    return await this.serialized(async () =>
      await this.cancelAttemptInternal(personalStateSubjectDigest(principal), attemptId)
    );
  }

  async forget(principal: string, request: ForgetRequest): Promise<{ operation: ForgetOperation; replay: boolean }> {
    return await this.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(principal);
      const now = this.isoNow();
      const begun = await this.options.journal.beginForget({
        subjectDigest,
        request,
        operationId: personalStateOperationId("forget", subjectDigest, request.forgetId),
        now,
        expiresAt: new Date(this.now() + this.options.receiptTtlMs).toISOString(),
      });
      if (begun.operation.state === "succeeded") return begun;
      let operation: ForgetOperation = {
        ...begun.operation,
        state: "running",
        updatedAt: this.isoNow(),
      };
      await this.options.journal.saveForget(operation);
      const provision = request.incarnation
        ? await this.options.journal.provision(subjectDigest, request.incarnation)
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

      operation = await this.runForgetPhase(operation, "attempts", async () => {
        let affected = 0;
        let stopUnknown = false;
        for (const attemptId of request.attemptIds) {
          try {
            const attempt = await this.cancelAttemptInternal(subjectDigest, attemptId);
            affected += 1;
            if (attempt.stopState === "stop_unknown") stopUnknown = true;
            const waiter = this.terminalWaiters.get(this.attemptKey(subjectDigest, attemptId));
            if (waiter) {
              const settled = await Promise.race([
                waiter.promise.then(() => true),
                new Promise<false>((resolve) => {
                  const timer = setTimeout(() => resolve(false), 15_000);
                  timer.unref?.();
                }),
              ]);
              if (!settled) stopUnknown = true;
            }
          } catch (error) {
            if (!(error instanceof PersonalStateControllerError && error.code === "personal_state_not_found")) throw error;
          }
        }
        return { affected, stopUnknown };
      });
      operation = await this.runForgetPhase(operation, "views", async () => {
        const result = await this.options.context.invalidatePersonalState({
          principal,
          contextIds: request.contextIds,
          sourceHandles: [...sourceHandles],
          sourceDigests: [
            ...invalidated.sourceDigests,
            ...(provision ? [provision.sourceDigest] : []),
          ],
          viewIds: invalidated.viewIds,
          attemptIds: request.attemptIds,
        }, async (plan) => {
          for (const descriptor of plan.descriptors) sourceHandles.add(descriptor.sourceHandle);
          const current = await this.options.journal.forget(subjectDigest, request.forgetId);
          if (!current) throw new Error("forget_operation_missing");
          const contextIds = new Set(request.contextIds);
          const sourceDigests = new Set([
            ...(current.resolved?.sourceDigests ?? []),
            ...plan.sourceDigests,
          ]);
          const durableViewIds = (await this.options.journal.viewsForSubject(subjectDigest))
            .filter((view) =>
              !view.dependencies
              || view.dependencies.contextIds.some((id) => contextIds.has(id))
              || view.dependencies.sourceDigests.some((digest) => sourceDigests.has(digest))
            )
            .map((view) => view.viewId);
          const resolvedViewIds = [...new Set([
            ...(current.resolved?.viewIds ?? []),
            ...plan.viewIds,
            ...durableViewIds,
          ])].sort();
          await this.options.journal.saveForget({
            ...current,
            resolved: {
              sourceHandles: [...sourceHandles].sort(),
              sourceDigests: [...sourceDigests].sort(),
              viewIds: resolvedViewIds,
            },
            updatedAt: this.isoNow(),
          });
          return { viewIds: resolvedViewIds };
        });
        invalidated = {
          descriptors: result.descriptors,
          viewIds: [...new Set([...invalidated.viewIds, ...result.viewIds])],
          sourceDigests: [...new Set([...invalidated.sourceDigests, ...result.sourceDigests])],
        };
        invalidationCompleted = true;
        for (const descriptor of invalidated.descriptors) sourceHandles.add(descriptor.sourceHandle);
        const invalidatedIds = new Set(invalidated.viewIds);
        for (const receipt of await this.options.journal.viewsForSubject(subjectDigest)) {
          if (!invalidatedIds.has(receipt.viewId)) continue;
          await this.options.journal.saveView({
            ...receipt,
            state: "invalid",
            updatedAt: this.isoNow(),
          });
        }
        return { affected: invalidated.viewIds.length };
      });
      operation = await this.runForgetPhase(operation, "runtime", async () => {
        if (!invalidationCompleted && (request.contextIds.length > 0 || sourceHandles.size > 0)) {
          throw new Error("runtime_dependencies_unresolved");
        }
        const attempts = await this.options.journal.attemptsFor(subjectDigest, request.attemptIds);
        const invalidatedViewIds = new Set(invalidated.viewIds);
        const views = (await this.options.journal.viewsForSubject(subjectDigest))
          .filter((view) => invalidatedViewIds.has(view.viewId));
        const candidateRuntimes = new Set([
          ...attempts.map((attempt) => attempt.runtime),
          ...views.map((view) => view.runtime),
          ...(provision ? [provision.runtime] : []),
        ]);
        const endpoints = new Map<string, Set<string>>();
        for (const runtime of candidateRuntimes) {
          const endpoint = this.options.context.personalStateCleanupEndpoint(runtime);
          if (!endpoint) {
            this.options.quarantineRuntime?.(runtime);
            throw new Error("runtime_cleanup_endpoint_unavailable");
          }
          const runtimes = endpoints.get(endpoint) ?? new Set<string>();
          runtimes.add(runtime);
          endpoints.set(endpoint, runtimes);
        }
        if (endpoints.size === 0) {
          for (const attempt of attempts.filter((item) => item.stopState === "stop_unknown")) {
            await this.options.journal.saveAttempt({
              ...attempt,
              stopState: "backend_stopped",
              backendStoppedAt: this.isoNow(),
              updatedAt: this.isoNow(),
            });
            this.options.clearRuntimeQuarantine?.(attempt.runtime);
          }
          return { affected: 0 };
        }
        if (!this.options.slotAdapter) {
          for (const runtimes of endpoints.values()) {
            for (const runtime of runtimes) this.options.quarantineRuntime?.(runtime);
          }
          return { affected: 0, stopUnknown: true };
        }
        let affected = 0;
        let stopUnknown = false;
        for (const endpoint of endpoints.keys()) {
          try {
            await this.options.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
            for (const runtime of endpoints.get(endpoint)!) {
              await this.confirmRuntimeStopped(runtime);
              this.options.clearRuntimeQuarantine?.(runtime);
            }
            affected += 1;
          } catch {
            stopUnknown = true;
            for (const runtime of endpoints.get(endpoint)!) {
              this.options.quarantineRuntime?.(runtime);
            }
          }
        }
        return { affected, stopUnknown };
      });
      operation = await this.runForgetPhase(operation, "snapshots", async () => {
        if (!invalidationCompleted) throw new Error("snapshot_absence_unverified");
        return { affected: invalidated.viewIds.length };
      });
      operation = await this.runForgetPhase(operation, "registry", async () => {
        if (!invalidationCompleted) throw new Error("registry_absence_unverified");
        return { affected: invalidated.descriptors.length };
      });
      operation = await this.runForgetPhase(operation, "sources", async () => {
        for (const handle of sourceHandles) await this.options.sourceStore.delete(principal, handle);
        const absence = await Promise.all([...sourceHandles].map((handle) =>
          this.options.sourceStore.absent(principal, handle)
        ));
        if (absence.some((value) => !value)) throw new Error("source_absence_unverified");
        return { affected: sourceHandles.size };
      });
      operation = await this.runForgetPhase(operation, "audit", async () => {
        if (!invalidationCompleted && (request.contextIds.length > 0 || sourceHandles.size > 0)) {
          throw new Error("audit_dependencies_unresolved");
        }
        if (!this.options.auditStore) return { affected: 0 };
        const result = await this.options.auditStore.erasePersonalState({
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
        updatedAt: this.isoNow(),
        ...(complete ? { completedAt: this.isoNow() } : { error: overallError }),
      };
      if (complete) delete operation.error;
      operation = await this.options.journal.saveForget(operation);
      return { operation, replay: begun.replay };
    });
  }

  async forgetReceipt(principal: string, forgetId: string): Promise<ForgetOperation> {
    const receipt = await this.options.journal.forget(personalStateSubjectDigest(principal), forgetId);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "forget operation not found");
    return receipt;
  }

  private async cancelAttemptInternal(subjectDigest: string, attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.options.journal.attempt(subjectDigest, attemptId);
    if (!attempt) throw new PersonalStateControllerError(404, "personal_state_not_found", "attempt not found");
    if (
      attempt.state === "completed"
      || attempt.state === "failed"
      || (attempt.state === "cancelled" && attempt.stopState !== "stop_unknown")
    ) return attempt;
    const now = this.isoNow();
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
      return await this.options.journal.saveAttempt({ ...attempt, stopState: "stop_unknown", updatedAt: this.isoNow() });
    }
    try {
      const endpoint = this.options.context.personalStateCleanupEndpoint(attempt.runtime);
      if (!endpoint) throw new Error("runtime cleanup endpoint is unavailable");
      await this.options.slotAdapter.erase(endpoint, 0, AbortSignal.timeout(15_000));
      const stopped = await this.options.journal.saveAttempt({
        ...attempt,
        stopState: "backend_stopped",
        backendStoppedAt: this.isoNow(),
        updatedAt: this.isoNow(),
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
        updatedAt: this.isoNow(),
        outcome: "remote_stop_unknown",
      });
    }
  }

  private async runForgetPhase(
    operation: ForgetOperation,
    phase: ForgetPhaseName,
    run: () => Promise<{ affected: number; stopUnknown?: boolean }>,
  ): Promise<ForgetOperation> {
    const running: ForgetOperation = {
      ...operation,
      phases: {
        ...operation.phases,
        [phase]: { state: "running", affected: 0, updatedAt: this.isoNow() },
      },
      updatedAt: this.isoNow(),
    };
    await this.options.journal.saveForget(running);
    try {
      const result = await run();
      const latest = await this.options.journal.forget(operation.subjectDigest, operation.forgetId)
        ?? running;
      const updated: ForgetOperation = {
        ...latest,
        phases: {
          ...latest.phases,
          [phase]: {
            state: result.stopUnknown ? "stop_unknown" : "absent",
            affected: result.affected,
            updatedAt: this.isoNow(),
          },
        },
        updatedAt: this.isoNow(),
      };
      return await this.options.journal.saveForget(updated);
    } catch (error) {
      const latest = await this.options.journal.forget(operation.subjectDigest, operation.forgetId)
        ?? running;
      const updated: ForgetOperation = {
        ...latest,
        phases: {
          ...latest.phases,
          [phase]: {
            state: "failed",
            affected: 0,
            updatedAt: this.isoNow(),
            error: error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code).slice(0, 128)
              : "phase_failed",
          },
        },
        updatedAt: this.isoNow(),
      };
      return await this.options.journal.saveForget(updated);
    }
  }

  private async confirmRuntimeStopped(runtime: string): Promise<void> {
    const now = this.isoNow();
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

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new PersonalStateControllerError(503, "personal_state_disabled", "Personal State delivery is disabled");
    }
  }

  private attemptKey(subjectDigest: string, attemptId: string): AttemptKey {
    return `${subjectDigest}\0${attemptId}`;
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
