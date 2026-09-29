import { createHash } from "node:crypto";
import {
  PERSONAL_STATE_CONTRACT_VERSION,
  personalStateOperationId,
  personalStateSourceHandle,
  personalStateSubjectDigest,
  type ContextRegistrationRequest,
  type SourceProvisionReceipt,
} from "@larm/core";
import type {
  LlamaContextTokenizer,
  LocalContextSourceStore,
  LocalPersonalStateJournal,
} from "@larm/backends";
import type { ContextController } from "./context-controller";
import { PersonalStateControllerError } from "./personal-state-controller-errors";

export type PersonalStateSourceDependencies = {
  journal: LocalPersonalStateJournal;
  context: Pick<ContextController, "productRuntimeBinding" | "register">;
  sourceStore: LocalContextSourceStore;
  tokenizer: LlamaContextTokenizer;
  sourceMaxBytes: number;
  sourceMaxTotalBytes: number;
  receiptTtlMs: number;
  now: () => number;
  isoNow: () => string;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>;
};

export class PersonalStateSourceCoordinator {
  constructor(private readonly dependencies: PersonalStateSourceDependencies) {}

  async provision(input: {
    principal: string;
    incarnation: string;
    allocationId: string;
    runtime: string;
    sourceDigest: string;
    content: string;
  }): Promise<{ receipt: SourceProvisionReceipt; replay: boolean }> {
    const d = this.dependencies;
    return await d.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(input.principal);
      const encoded = new TextEncoder().encode(input.content);
      if (encoded.byteLength === 0) {
        throw new PersonalStateControllerError(400, "personal_state_request_invalid", "source must not be empty");
      }
      if (encoded.byteLength > d.sourceMaxBytes) {
        throw new PersonalStateControllerError(413, "personal_state_request_invalid", "source exceeds the byte limit");
      }
      if (createHash("sha256").update(encoded).digest("hex") !== input.sourceDigest) {
        throw new PersonalStateControllerError(400, "personal_state_request_invalid", "source digest does not match content");
      }
      const existing = await d.journal.provision(subjectDigest, input.incarnation);
      if (existing && (
        existing.sourceDigest !== input.sourceDigest
        || existing.allocationId !== input.allocationId
        || existing.runtime !== input.runtime
      )) {
        throw new PersonalStateControllerError(
          409,
          "incarnation_conflict",
          "source incarnation is already bound to different immutable content",
        );
      }
      if (await d.journal.isForgotten({ subjectDigest, incarnation: input.incarnation })) {
        throw new PersonalStateControllerError(409, "forget_in_progress", "source incarnation is tombstoned");
      }
      if (existing?.state === "succeeded") return { receipt: existing, replay: true };
      const binding = d.context.productRuntimeBinding(input.allocationId, input.runtime);
      const dataEpoch = await d.journal.currentEpoch(subjectDigest);
      let tokenCount: number;
      try {
        tokenCount = await d.tokenizer.countSourceTokens(
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
      const sourceHandle = personalStateSourceHandle({
        subjectDigest,
        incarnation: input.incarnation,
        sourceDigest: input.sourceDigest,
      });
      const now = d.isoNow();
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
        byteCount: encoded.byteLength,
        tokenCount,
        tokenizerDigest: binding.tokenizerDigest,
        chatTemplateDigest: binding.chatTemplateDigest,
        leaseEpoch: binding.leaseEpoch,
        dataEpoch,
        state: "running",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: new Date(d.now() + d.receiptTtlMs).toISOString(),
      };
      await d.journal.saveProvision(receipt);
      try {
        await d.journal.assertEpoch(subjectDigest, dataEpoch);
        const result = await d.sourceStore.provisionImmutable(
          input.principal,
          sourceHandle,
          input.content,
          input.sourceDigest,
          {
            maxSourceBytes: d.sourceMaxBytes,
            maxTotalBytes: d.sourceMaxTotalBytes,
            filesystemFreeFloorBytes: binding.filesystemFreeFloorBytes,
            tokenizations: [{ tokenizerDigest: binding.tokenizerDigest, tokenCount }],
          },
        );
        await d.journal.assertEpoch(subjectDigest, dataEpoch);
        receipt = { ...receipt, byteCount: result.bytes, state: "succeeded", updatedAt: d.isoNow() };
        await d.journal.saveProvision(receipt);
        return { receipt, replay: result.replay || existing !== undefined };
      } catch (error) {
        receipt = {
          ...receipt,
          state: "failed",
          error: error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code).slice(0, 128)
            : "source_commit_failed",
          updatedAt: d.isoNow(),
        };
        await d.journal.saveProvision(receipt).catch(() => undefined);
        if (error instanceof Error && "code" in error
          && (error as { code?: string }).code === "context_source_immutable_conflict") {
          throw new PersonalStateControllerError(409, "incarnation_conflict", "immutable source conflicts");
        }
        throw new PersonalStateControllerError(503, "personal_state_unavailable", "source commit failed");
      }
    });
  }

  async provisionReceipt(principal: string, incarnation: string): Promise<SourceProvisionReceipt> {
    const receipt = await this.dependencies.journal.provision(personalStateSubjectDigest(principal), incarnation);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "source receipt not found");
    return receipt;
  }

  async registerContext(input: {
    principal: string;
    allocationId: string;
    request: ContextRegistrationRequest;
    idempotencyKey: string;
  }): Promise<Awaited<ReturnType<ContextController["register"]>>> {
    const d = this.dependencies;
    return await d.serialized(async () => {
      const subjectDigest = personalStateSubjectDigest(input.principal);
      if (
        await d.journal.isForgotten({ subjectDigest, contextId: input.request.id })
        || await d.journal.isForgotten({ subjectDigest, sourceHandle: input.request.sourceHandle })
      ) {
        throw new PersonalStateControllerError(409, "forget_in_progress", "context or source is tombstoned");
      }
      const provision = await d.journal.provisionBySourceHandle(subjectDigest, input.request.sourceHandle);
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
      return await d.context.register(input.request, input.principal, input.idempotencyKey);
    });
  }
}
