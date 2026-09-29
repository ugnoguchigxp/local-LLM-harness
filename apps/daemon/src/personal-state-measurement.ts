import {
  PERSONAL_STATE_CONTRACT_VERSION,
  personalStateDigest,
  personalStateSubjectDigest,
  type CanonicalMeasurementReceipt,
  type CanonicalMeasurementRequest,
} from "@larm/core";
import type { LocalPersonalStateJournal } from "@larm/backends";
import type { ContextController } from "./context-controller";
import { PersonalStateControllerError } from "./personal-state-controller-errors";

type PersonalStateMeasurementOptions = {
  enabled: boolean;
  journal: LocalPersonalStateJournal;
  context: ContextController;
  receiptTtlMs: number;
  now: () => number;
  isoNow: () => string;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>;
};

export class PersonalStateMeasurement {
  constructor(private readonly options: PersonalStateMeasurementOptions) {}

  async measure(
    principal: string,
    request: CanonicalMeasurementRequest,
  ): Promise<{ receipt: CanonicalMeasurementReceipt; replay: boolean }> {
    if (!this.options.enabled) {
      throw new PersonalStateControllerError(503, "personal_state_disabled", "Personal State delivery is disabled");
    }
    return await this.options.serialized(async () => {
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
      const now = this.options.isoNow();
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
        expiresAt: new Date(this.options.now() + Math.min(this.options.receiptTtlMs, 15 * 60_000)).toISOString(),
      };
      await this.options.journal.saveMeasurement(receipt);
      return { receipt, replay: false };
    });
  }

  async receipt(principal: string, id: string): Promise<CanonicalMeasurementReceipt> {
    const receipt = await this.options.journal.measurement(personalStateSubjectDigest(principal), id);
    if (!receipt) throw new PersonalStateControllerError(404, "personal_state_not_found", "measurement not found");
    return receipt;
  }
}
