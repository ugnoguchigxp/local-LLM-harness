import type { ContextSourceProvider } from "@larm/backends";
import type {
  ActiveContextView,
  ContextDescriptor,
  ContextRegistrationRequest,
  Registry,
} from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";
import { invalidateReadyContextViews } from "./context-view-lifecycle";

export type PublicContextDescriptor = Omit<ContextDescriptor, "principal">;

export function publicContextDescriptor(descriptor: ContextDescriptor): PublicContextDescriptor {
  const { principal: _principal, ...result } = descriptor;
  return result;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type ContextSourceRegistryOptions = {
  registry: Registry;
  sourceProvider: ContextSourceProvider;
  sourceMaxBytes: number;
  sourceMaxTotalBytes: number;
  descriptors: Map<string, ContextDescriptor>;
  views: Map<string, ActiveContextView>;
  descriptorKey: (principal: string, id: string, version: string) => string;
  hash: (value: unknown) => string;
  replay: <T>(principal: string, scope: string, key: string, requestHash: string) => T | undefined;
  remember: (principal: string, scope: string, key: string, requestHash: string, result: unknown) => void;
  assertIdempotencyCapacity: () => void;
  persist: () => Promise<void>;
  now: () => number;
  isoNow: () => string;
  prune: () => void;
  emit: (name: string, labels: Record<string, string>, value?: number) => void;
};

export class ContextSourceRegistryLifecycle {
  constructor(private readonly options: ContextSourceRegistryOptions) {}

  async register(
    request: ContextRegistrationRequest,
    principal: string,
    idempotencyKey: string,
  ): Promise<{ descriptor: PublicContextDescriptor; replay: boolean }> {
    const d = this.options;
    return await registerContextSource({
      request,
      principal,
      idempotencyKey,
      registry: d.registry,
      sourceProvider: d.sourceProvider,
      sourceMaxBytes: d.sourceMaxBytes,
      sourceMaxTotalBytes: d.sourceMaxTotalBytes,
      descriptors: d.descriptors,
      descriptorKey: d.descriptorKey,
      hash: d.hash,
      replay: d.replay,
      remember: d.remember,
      assertIdempotencyCapacity: d.assertIdempotencyCapacity,
      persist: d.persist,
      now: d.isoNow,
      emitRegistered: (classification) => d.emit("context_registered", { classification }),
    });
  }

  list(
    principal: string,
    options: { cursor?: string; limit?: number } = {},
  ): { contexts: PublicContextDescriptor[]; nextCursor?: string } {
    const d = this.options;
    d.prune();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ContextControllerError(400, "context_request_invalid", "limit must be from 1 through 500");
    }
    let after: [string, string] | undefined;
    if (options.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (
          !Array.isArray(decoded)
          || decoded.length !== 2
          || decoded.some((item) => typeof item !== "string")
          || Buffer.from(JSON.stringify(decoded)).toString("base64url") !== options.cursor
        ) throw new Error("noncanonical cursor");
        after = decoded as [string, string];
      } catch {
        throw new ContextControllerError(400, "context_request_invalid", "context cursor is invalid");
      }
    }
    const sorted = [...d.descriptors.values()]
      .filter((descriptor) => descriptor.principal === principal && descriptor.state !== "deleted")
      .sort((left, right) =>
        compareCanonicalText(left.id, right.id) || compareCanonicalText(left.version, right.version)
      )
      .filter((descriptor) => !after
        || compareCanonicalText(descriptor.id, after[0]) > 0
        || (descriptor.id === after[0] && compareCanonicalText(descriptor.version, after[1]) > 0));
    const page = sorted.slice(0, limit);
    const last = page.at(-1);
    return {
      contexts: page.map(publicContextDescriptor),
      ...(sorted.length > page.length && last
        ? { nextCursor: Buffer.from(JSON.stringify([last.id, last.version])).toString("base64url") }
        : {}),
    };
  }

  async delete(
    principal: string,
    id: string,
    idempotencyKey: string,
  ): Promise<{ deleted: number; replay: boolean }> {
    const d = this.options;
    const scope = `/v1/contexts/${id}`;
    const requestHash = d.hash({ operation: "delete", principal, id });
    const replay = d.replay<{ deleted: number }>(principal, scope, idempotencyKey, requestHash);
    if (replay) return { ...replay, replay: true };
    d.assertIdempotencyCapacity();
    let deleted = 0;
    const removed: Array<[string, ContextDescriptor]> = [];
    for (const [key, descriptor] of d.descriptors) {
      if (descriptor.principal !== principal || descriptor.id !== id) continue;
      removed.push([key, descriptor]);
      deleted += 1;
    }
    if (deleted > 0) {
      const affectedViews = [...d.views.values()].filter((view) =>
        view.principal === principal
        && view.orderedItems.some((item) => item.contextId === id)
        && view.state === "ready"
      );
      for (const [key] of removed) d.descriptors.delete(key);
      try {
        await d.persist();
      } catch (error) {
        for (const [key, descriptor] of removed) d.descriptors.set(key, descriptor);
        throw new ContextControllerError(
          503,
          "context_subsystem_degraded",
          `context metadata could not be committed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      invalidateReadyContextViews(affectedViews);
      d.emit("context_deleted", { result: "deleted" }, deleted);
    }
    const result = { deleted };
    d.remember(principal, scope, idempotencyKey, requestHash, result);
    return { ...result, replay: false };
  }
}

export async function registerContextSource(input: {
  request: ContextRegistrationRequest;
  principal: string;
  idempotencyKey: string;
  registry: Registry;
  sourceProvider: ContextSourceProvider;
  sourceMaxBytes: number;
  sourceMaxTotalBytes: number;
  descriptors: Map<string, ContextDescriptor>;
  descriptorKey: (principal: string, id: string, version: string) => string;
  hash: (value: unknown) => string;
  replay: <T>(principal: string, scope: string, key: string, requestHash: string) => T | undefined;
  remember: (principal: string, scope: string, key: string, requestHash: string, result: unknown) => void;
  assertIdempotencyCapacity: () => void;
  persist: () => Promise<void>;
  now: () => string;
  emitRegistered: (classification: string) => void;
}): Promise<{ descriptor: PublicContextDescriptor; replay: boolean }> {
  const { request, principal, idempotencyKey } = input;
  const requestHash = input.hash({ operation: "register", principal, request });
  const replay = input.replay<{ descriptor: PublicContextDescriptor }>(
    principal,
    "/v1/contexts",
    idempotencyKey,
    requestHash,
  );
  if (replay) return { ...replay, replay: true };
  input.assertIdempotencyCapacity();

  const maxSourceTokens = Math.max(0, ...input.registry.runtimes.map((runtime) =>
    runtime.context?.class === "managed-context" ? runtime.context.sourceTokenLimit : 0
  ));
  if (maxSourceTokens === 0) {
    throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
  }
  const key = input.descriptorKey(principal, request.id, request.version);
  const existing = input.descriptors.get(key);
  if (existing && (
    existing.sourceHandle !== request.sourceHandle
    || existing.sourceDigest !== request.sourceDigest
    || existing.classification !== request.classification
    || existing.byteCount !== request.byteCount
    || existing.tokenCount !== request.tokenCount
    || existing.tokenizerDigest !== request.tokenizerDigest
    || existing.expiresAt !== request.expiresAt
  )) {
    throw new ContextControllerError(
      409,
      "context_version_conflict",
      `context ${request.id}@${request.version} is immutable; register a new version`,
    );
  }

  let source;
  try {
    source = await input.sourceProvider.read(
      principal,
      request.sourceHandle,
      request.sourceDigest,
      input.sourceMaxBytes,
    );
  } catch {
    throw new ContextControllerError(409, "context_source_invalid", "context source could not be verified");
  }
  const tokenization = source.tokenizations.find((item) => item.tokenizerDigest === request.tokenizerDigest);
  if (!tokenization || tokenization.tokenCount !== request.tokenCount) {
    throw new ContextControllerError(
      409,
      "context_source_invalid",
      "context token count is not attested by the canonical tokenizer",
    );
  }
  if (source.bytes !== request.byteCount) {
    throw new ContextControllerError(
      409,
      "context_source_invalid",
      "context byte count does not match the immutable source",
    );
  }

  const activeDescriptors = [...input.descriptors.values()]
    .filter((descriptor) => descriptor.principal === principal && descriptor.state === "active");
  const currentTokens = activeDescriptors.reduce((total, item) => total + item.tokenCount, 0)
    - (existing?.tokenCount ?? 0);
  if (currentTokens + request.tokenCount > maxSourceTokens) {
    throw new ContextControllerError(
      409,
      "context_source_limit_exceeded",
      `context source set would exceed ${maxSourceTokens} tokens`,
    );
  }
  const currentBytes = activeDescriptors.reduce((total, item) => total + item.byteCount, 0)
    - (existing?.byteCount ?? 0);
  if (currentBytes + request.byteCount > input.sourceMaxTotalBytes) {
    throw new ContextControllerError(
      409,
      "context_source_limit_exceeded",
      `context source set would exceed ${input.sourceMaxTotalBytes} bytes`,
    );
  }
  if (existing) {
    const result = { descriptor: publicContextDescriptor(existing) };
    input.remember(principal, "/v1/contexts", idempotencyKey, requestHash, result);
    return { ...result, replay: false };
  }
  if (input.descriptors.size >= 100_000) {
    throw new ContextControllerError(503, "context_subsystem_degraded", "context descriptor capacity is exhausted");
  }

  const now = input.now();
  const descriptor: ContextDescriptor = {
    schemaVersion: 1,
    ...request,
    principal,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  input.descriptors.set(key, descriptor);
  try {
    await input.persist();
  } catch (error) {
    input.descriptors.delete(key);
    throw new ContextControllerError(
      503,
      "context_subsystem_degraded",
      `context metadata could not be committed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = { descriptor: publicContextDescriptor(descriptor) };
  input.remember(principal, "/v1/contexts", idempotencyKey, requestHash, result);
  input.emitRegistered(descriptor.classification);
  return { ...result, replay: false };
}
