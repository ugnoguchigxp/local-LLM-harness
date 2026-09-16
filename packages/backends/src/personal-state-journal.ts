import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  forgetIsComplete,
  forgetPhaseNameSchema,
  personalStateDigest,
  personalStateJournalSchema,
  type CanonicalMeasurementReceipt,
  type ForgetOperation,
  type ForgetRequest,
  type GenerationAttempt,
  type PersonalStateJournal,
  type PersonalStateViewReceipt,
  type SourceProvisionReceipt,
} from "@larm/core";

export class PersonalStateJournalError extends Error {
  constructor(
    readonly code:
      | "unsafe_personal_state_root"
      | "personal_state_journal_corrupt"
      | "personal_state_journal_write_failed"
      | "personal_state_conflict"
      | "personal_state_not_found"
      | "personal_state_epoch_stale",
    message: string,
  ) {
    super(message);
    this.name = "PersonalStateJournalError";
  }
}

function safeRoot(root: string): string {
  if (!root.startsWith("/")) {
    throw new PersonalStateJournalError("unsafe_personal_state_root", "personal state root must be absolute");
  }
  const normalized = resolve(root);
  if (normalized === dirname(normalized)) {
    throw new PersonalStateJournalError(
      "unsafe_personal_state_root",
      "personal state root must not be a filesystem root",
    );
  }
  return normalized;
}

async function initializeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(root) !== root) {
    throw new PersonalStateJournalError(
      "unsafe_personal_state_root",
      "personal state root must be a canonical real directory",
    );
  }
}

async function atomicWrite(root: string, target: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(root, `.personal-state.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LocalPersonalStateJournal {
  readonly root: string;
  private readonly path: string;
  private state?: PersonalStateJournal;
  private initializing?: Promise<void>;
  private mutationChain = Promise.resolve();

  constructor(root: string, private readonly daemonBootEpoch?: string) {
    this.root = safeRoot(root);
    this.path = join(this.root, "journal.json");
  }

  async initialize(): Promise<void> {
    if (this.state) return;
    if (this.initializing) return await this.initializing;
    this.initializing = this.initializeInternal();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  private async initializeInternal(): Promise<void> {
    await initializeRoot(this.root);
    let state: PersonalStateJournal;
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024 * 1024) {
        throw new Error("journal file is unsafe");
      }
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile()
          || opened.dev !== metadata.dev
          || opened.ino !== metadata.ino
          || opened.size > 128 * 1024 * 1024
        ) throw new Error("journal changed during open");
        state = personalStateJournalSchema.parse(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PersonalStateJournalError(
          "personal_state_journal_corrupt",
          `failed to read personal state journal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      state = {
        schemaVersion: 1,
        bootEpoch: randomUUID(),
        subjects: [],
        provisions: [],
        measurements: [],
        views: [],
        attempts: [],
        forgets: [],
      };
    }
    const nextBootEpoch = this.daemonBootEpoch ?? randomUUID();
    const bootChanged = state.bootEpoch !== nextBootEpoch;
    state.bootEpoch = nextBootEpoch;
    if (bootChanged) {
      const restartedAt = new Date().toISOString();
      state.views = state.views.map((view) => view.state === "ready"
        ? { ...view, state: "invalid" as const, updatedAt: restartedAt }
        : view);
    }
    this.state = personalStateJournalSchema.parse(state);
    await this.writeState();
  }

  async snapshot(): Promise<PersonalStateJournal> {
    await this.initialize();
    return clone(this.state!);
  }

  async bootEpoch(): Promise<string> {
    await this.initialize();
    return this.state!.bootEpoch;
  }

  async currentEpoch(subjectDigest: string): Promise<number> {
    await this.initialize();
    return this.state!.subjects.find((item) => item.subjectDigest === subjectDigest)?.dataEpoch ?? 0;
  }

  async assertEpoch(subjectDigest: string, expected: number): Promise<void> {
    const current = await this.currentEpoch(subjectDigest);
    if (current !== expected) {
      throw new PersonalStateJournalError(
        "personal_state_epoch_stale",
        `personal state epoch changed from ${expected} to ${current}`,
      );
    }
  }

  async saveProvision(receipt: SourceProvisionReceipt): Promise<SourceProvisionReceipt> {
    return await this.mutate((state) => {
      const index = state.provisions.findIndex((item) =>
        item.subjectDigest === receipt.subjectDigest && item.incarnation === receipt.incarnation
      );
      if (index >= 0) {
        const existing = state.provisions[index]!;
        if (
          existing.sourceDigest !== receipt.sourceDigest
          || existing.allocationId !== receipt.allocationId
          || existing.runtime !== receipt.runtime
          || existing.sourceHandle !== receipt.sourceHandle
        ) {
          throw new PersonalStateJournalError(
            "personal_state_conflict",
            "source incarnation is already bound to different immutable content",
          );
        }
        state.provisions[index] = receipt;
      } else {
        state.provisions.push(receipt);
      }
      return clone(receipt);
    });
  }

  async provision(subjectDigest: string, incarnation: string): Promise<SourceProvisionReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.provisions.find((item) =>
      item.subjectDigest === subjectDigest && item.incarnation === incarnation
    );
    return receipt ? clone(receipt) : undefined;
  }

  async provisionBySourceHandle(
    subjectDigest: string,
    sourceHandle: string,
  ): Promise<SourceProvisionReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.provisions.find((item) =>
      item.subjectDigest === subjectDigest && item.sourceHandle === sourceHandle
    );
    return receipt ? clone(receipt) : undefined;
  }

  async saveMeasurement(receipt: CanonicalMeasurementReceipt): Promise<CanonicalMeasurementReceipt> {
    return await this.mutate((state) => {
      const index = state.measurements.findIndex((item) =>
        item.subjectDigest === receipt.subjectDigest && item.measurementId === receipt.measurementId
      );
      if (index >= 0) {
        const existing = state.measurements[index]!;
        if (
          existing.subjectDigest !== receipt.subjectDigest
          || existing.requestDigest !== receipt.requestDigest
          || existing.allocationId !== receipt.allocationId
          || existing.runtime !== receipt.runtime
          || existing.maxInputTokens !== receipt.maxInputTokens
        ) {
          throw new PersonalStateJournalError(
            "personal_state_conflict",
            "measurement ID is already bound to another request",
          );
        }
      }
      if (index >= 0) state.measurements[index] = receipt;
      else state.measurements.push(receipt);
      return clone(receipt);
    });
  }

  async measurement(subjectDigest: string, id: string): Promise<CanonicalMeasurementReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.measurements.find((item) =>
      item.subjectDigest === subjectDigest && item.measurementId === id
    );
    return receipt ? clone(receipt) : undefined;
  }

  async saveView(receipt: PersonalStateViewReceipt): Promise<PersonalStateViewReceipt> {
    return await this.mutate((state) => {
      const index = state.views.findIndex((item) =>
        item.subjectDigest === receipt.subjectDigest && item.viewRequestId === receipt.viewRequestId
      );
      if (index >= 0) {
        const existing = state.views[index]!;
        if (
          existing.requestDigest !== receipt.requestDigest
          || existing.planDigest !== receipt.planDigest
          || existing.idempotencyKeyDigest !== receipt.idempotencyKeyDigest
          || existing.allocationId !== receipt.allocationId
          || existing.runtime !== receipt.runtime
        ) {
          throw new PersonalStateJournalError(
            "personal_state_conflict",
            "view request ID is already bound to another request",
          );
        }
        state.views[index] = receipt;
      } else {
        state.views.push(receipt);
      }
      return clone(receipt);
    });
  }

  async view(subjectDigest: string, id: string): Promise<PersonalStateViewReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.views.find((item) =>
      item.subjectDigest === subjectDigest && item.viewRequestId === id
    );
    return receipt ? clone(receipt) : undefined;
  }

  async viewByIdempotencyKeyDigest(
    subjectDigest: string,
    digest: string,
  ): Promise<PersonalStateViewReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.views.find((item) =>
      item.subjectDigest === subjectDigest && item.idempotencyKeyDigest === digest
    );
    return receipt ? clone(receipt) : undefined;
  }

  async viewByViewId(subjectDigest: string, viewId: string): Promise<PersonalStateViewReceipt | undefined> {
    await this.initialize();
    const receipt = this.state!.views.find((item) =>
      item.subjectDigest === subjectDigest && item.viewId === viewId
    );
    return receipt ? clone(receipt) : undefined;
  }

  async viewsForSubject(subjectDigest: string): Promise<PersonalStateViewReceipt[]> {
    await this.initialize();
    return this.state!.views.filter((item) => item.subjectDigest === subjectDigest).map(clone);
  }

  async saveAttempt(attempt: GenerationAttempt): Promise<GenerationAttempt> {
    return await this.mutate((state) => {
      const index = state.attempts.findIndex((item) =>
        item.subjectDigest === attempt.subjectDigest && item.attemptId === attempt.attemptId
      );
      if (index >= 0) {
        const existing = state.attempts[index]!;
        if (
          existing.requestDigest !== attempt.requestDigest
          || existing.allocationId !== attempt.allocationId
          || existing.runtime !== attempt.runtime
        ) {
          throw new PersonalStateJournalError(
            "personal_state_conflict",
            "generation attempt ID is already bound to another request",
          );
        }
        if (existing.stopState === "backend_stopped" && attempt.stopState !== "backend_stopped") {
          attempt = {
            ...attempt,
            stopState: "backend_stopped",
            ...(existing.backendStoppedAt ? { backendStoppedAt: existing.backendStoppedAt } : {}),
          };
        }
        if (
          (existing.cancelRequestedAt || existing.state === "cancelled")
          && attempt.state !== "cancelled"
        ) {
          attempt = {
            ...attempt,
            state: "cancelled",
            ...(existing.cancelRequestedAt ? { cancelRequestedAt: existing.cancelRequestedAt } : {}),
            ...(existing.outcome ? { outcome: existing.outcome } : {}),
          };
        }
        attempt = {
          ...attempt,
          ...(existing.forwardedAt && !attempt.forwardedAt ? { forwardedAt: existing.forwardedAt } : {}),
          ...(existing.cancelRequestedAt && !attempt.cancelRequestedAt
            ? { cancelRequestedAt: existing.cancelRequestedAt }
            : {}),
          ...(existing.transportClosedAt && !attempt.transportClosedAt
            ? { transportClosedAt: existing.transportClosedAt }
            : {}),
          ...(existing.backendStoppedAt && !attempt.backendStoppedAt
            ? { backendStoppedAt: existing.backendStoppedAt }
            : {}),
        };
        state.attempts[index] = attempt;
      } else {
        state.attempts.push(attempt);
      }
      return clone(attempt);
    });
  }

  async attempt(subjectDigest: string, id: string): Promise<GenerationAttempt | undefined> {
    await this.initialize();
    const attempt = this.state!.attempts.find((item) =>
      item.subjectDigest === subjectDigest && item.attemptId === id
    );
    return attempt ? clone(attempt) : undefined;
  }

  async attemptsFor(subjectDigest: string, ids: string[]): Promise<GenerationAttempt[]> {
    await this.initialize();
    const wanted = new Set(ids);
    return this.state!.attempts
      .filter((item) => item.subjectDigest === subjectDigest && wanted.has(item.attemptId))
      .map(clone);
  }

  async beginForget(input: {
    subjectDigest: string;
    request: ForgetRequest;
    operationId: string;
    now: string;
    expiresAt: string;
  }): Promise<{ operation: ForgetOperation; replay: boolean }> {
    return await this.mutate((state) => {
      const requestDigest = personalStateDigest(input.request);
      const existing = state.forgets.find((item) =>
        item.subjectDigest === input.subjectDigest && item.forgetId === input.request.forgetId
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new PersonalStateJournalError(
            "personal_state_conflict",
            "forget ID is already bound to different targets",
          );
        }
        return { operation: clone(existing), replay: true };
      }
      let subject = state.subjects.find((item) => item.subjectDigest === input.subjectDigest);
      if (!subject) {
        subject = { subjectDigest: input.subjectDigest, dataEpoch: 0, updatedAt: input.now, tombstones: [] };
        state.subjects.push(subject);
      }
      subject.dataEpoch += 1;
      subject.updatedAt = input.now;
      subject.tombstones.push({
        forgetId: input.request.forgetId,
        fenceEpoch: subject.dataEpoch,
        targetDigest: personalStateDigest({
          incarnation: input.request.incarnation,
          contextIds: input.request.contextIds,
          sourceHandles: input.request.sourceHandles,
          attemptIds: input.request.attemptIds,
        }),
        targets: {
          ...(input.request.incarnation ? { incarnation: input.request.incarnation } : {}),
          contextIds: input.request.contextIds,
          sourceHandles: input.request.sourceHandles,
          attemptIds: input.request.attemptIds,
        },
        createdAt: input.now,
      });
      const phases = Object.fromEntries(forgetPhaseNameSchema.options.map((name) => [name, {
        state: "pending" as const,
        updatedAt: input.now,
        affected: 0,
      }])) as ForgetOperation["phases"];
      const operation: ForgetOperation = {
        contractVersion: "larm-personal-state.v1",
        forgetId: input.request.forgetId,
        operationId: input.operationId,
        subjectDigest: input.subjectDigest,
        requestDigest,
        targets: {
          ...(input.request.incarnation ? { incarnation: input.request.incarnation } : {}),
          contextIds: input.request.contextIds,
          sourceHandles: input.request.sourceHandles,
          attemptIds: input.request.attemptIds,
        },
        fenceEpoch: subject.dataEpoch,
        state: "accepted",
        phases,
        absenceVerified: false,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
      };
      state.forgets.push(operation);
      return { operation: clone(operation), replay: false };
    });
  }

  async saveForget(operation: ForgetOperation): Promise<ForgetOperation> {
    return await this.mutate((state) => {
      const index = state.forgets.findIndex((item) =>
        item.subjectDigest === operation.subjectDigest && item.forgetId === operation.forgetId
      );
      if (index < 0) {
        throw new PersonalStateJournalError("personal_state_not_found", "forget operation was not found");
      }
      const checked = { ...operation };
      if (forgetIsComplete(checked)) {
        checked.state = "succeeded";
        checked.completedAt ??= checked.updatedAt;
      }
      state.forgets[index] = checked;
      return clone(checked);
    });
  }

  async forget(subjectDigest: string, id: string): Promise<ForgetOperation | undefined> {
    await this.initialize();
    const operation = this.state!.forgets.find((item) =>
      item.subjectDigest === subjectDigest && item.forgetId === id
    );
    return operation ? clone(operation) : undefined;
  }

  async isForgotten(input: {
    subjectDigest: string;
    incarnation?: string;
    contextId?: string;
    sourceHandle?: string;
    attemptId?: string;
  }): Promise<boolean> {
    await this.initialize();
    const subject = this.state!.subjects.find((item) => item.subjectDigest === input.subjectDigest);
    return subject?.tombstones.some((tombstone) =>
      (input.incarnation !== undefined && tombstone.targets.incarnation === input.incarnation)
      || (input.contextId !== undefined && tombstone.targets.contextIds.includes(input.contextId))
      || (input.sourceHandle !== undefined && tombstone.targets.sourceHandles.includes(input.sourceHandle))
      || (input.attemptId !== undefined && tombstone.targets.attemptIds.includes(input.attemptId))
    ) ?? false;
  }

  async prune(now: number): Promise<void> {
    await this.mutate((state) => {
      state.provisions = state.provisions.filter((item) => {
        if (Date.parse(item.expiresAt) > now) return true;
        return !state.forgets.some((operation) =>
          operation.subjectDigest === item.subjectDigest
          && operation.state === "succeeded"
          && operation.absenceVerified
          && (
            operation.targets.incarnation === item.incarnation
            || operation.targets.sourceHandles.includes(item.sourceHandle)
          )
        );
      });
      state.measurements = state.measurements.filter((item) => Date.parse(item.expiresAt) > now);
      state.views = state.views.filter((item) => Date.parse(item.expiresAt) > now);
      state.forgets = state.forgets.filter((item) => Date.parse(item.expiresAt) > now);
      state.attempts = state.attempts.filter((item) => {
        const terminal = item.terminalAt ? Date.parse(item.terminalAt) : Number.POSITIVE_INFINITY;
        return terminal + 24 * 60 * 60 * 1_000 > now;
      });
    });
  }

  private async mutate<T>(operation: (state: PersonalStateJournal) => T): Promise<T> {
    await this.initialize();
    let result!: T;
    const mutation = this.mutationChain.then(async () => {
      const candidate = clone(this.state!);
      result = operation(candidate);
      const checked = personalStateJournalSchema.parse(candidate);
      await this.writeState(checked);
      this.state = checked;
    });
    this.mutationChain = mutation.then(() => undefined, () => undefined);
    try {
      await mutation;
      return clone(result);
    } catch (error) {
      if (error instanceof PersonalStateJournalError) throw error;
      throw new PersonalStateJournalError(
        "personal_state_journal_write_failed",
        `failed to update personal state journal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async writeState(state = this.state): Promise<void> {
    try {
      const checked = personalStateJournalSchema.parse(state);
      await atomicWrite(
        this.root,
        this.path,
        new TextEncoder().encode(`${JSON.stringify(checked, null, 2)}\n`),
      );
    } catch (error) {
      if (error instanceof PersonalStateJournalError) throw error;
      throw new PersonalStateJournalError(
        "personal_state_journal_write_failed",
        `failed to write personal state journal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
