import type { ControlEvent } from "./controller";

export type ExecutionPolicy = {
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  queueTimeoutMs: number;
};

export class ExecutionGateError extends Error {
  constructor(
    readonly code: "queue_full" | "queue_timeout" | "request_cancelled" | "draining" | "runtime_quarantined" | "exclusive_execution",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ExecutionGateError";
  }
}

type QueueEntry = {
  resolve: (release: () => void) => void;
  reject: (error: ExecutionGateError) => void;
  signal: AbortSignal;
  queuedAt: number;
  priority: number;
  sequence: number;
  timeout: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

type RuntimeGate = { active: number; queue: QueueEntry[] };

type ExclusiveEntry = {
  runtime: string;
  policy: ExecutionPolicy;
  signal: AbortSignal;
  priority: number;
  queuedAt: number;
  phase: "pending" | "active";
  resolve: (release: () => void) => void;
  reject: (error: ExecutionGateError) => void;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
};

export class ExecutionGate {
  private readonly runtimes = new Map<string, RuntimeGate>();
  private readonly quarantinedRuntimes = new Set<string>();
  private draining = false;
  private sequence = 0;
  private exclusive?: ExclusiveEntry;
  private readonly heldPromotions = new Map<string, {
    state: RuntimeGate;
    policy: ExecutionPolicy;
  }>();

  constructor(
    private readonly options: {
      now?: () => number;
      onEvent?: (event: ControlEvent) => void;
      onState?: (runtime: string, state: { active: number; queued: number }) => void;
    } = {},
  ) {}

  beginDrain(): void {
    this.draining = true;
    if (this.exclusive?.phase === "pending") {
      const entry = this.exclusive;
      this.clearExclusiveListeners(entry);
      this.exclusive = undefined;
      entry.reject(new ExecutionGateError("draining", "execution gate is draining"));
    }
    for (const [runtime, state] of this.runtimes) {
      for (const entry of state.queue.splice(0)) {
        this.removeEntryListeners(entry);
        entry.reject(new ExecutionGateError("draining", "execution gate is draining"));
        this.emit("execution_request", runtime, "draining");
      }
      this.emitState(runtime, state);
    }
  }

  quarantineRuntime(runtime: string): void {
    this.quarantinedRuntimes.add(runtime);
    const state = this.runtimes.get(runtime);
    if (!state) return;
    for (const entry of state.queue.splice(0)) {
      this.removeEntryListeners(entry);
      entry.reject(new ExecutionGateError(
        "runtime_quarantined",
        `runtime ${runtime} is quarantined pending backend stop confirmation`,
      ));
    }
    this.emit("execution_request", runtime, "runtime_quarantined");
    this.emitState(runtime, state);
  }

  clearRuntimeQuarantine(runtime: string): void {
    if (this.quarantinedRuntimes.delete(runtime)) {
      this.emit("execution_request", runtime, "runtime_quarantine_cleared");
    }
  }

  isRuntimeQuarantined(runtime: string): boolean {
    return this.quarantinedRuntimes.has(runtime);
  }

  async acquire(
    runtime: string,
    policy: ExecutionPolicy,
    signal: AbortSignal,
    priority = 0,
  ): Promise<() => void> {
    if (this.draining) {
      throw new ExecutionGateError("draining", "execution gate is draining");
    }
    if (this.quarantinedRuntimes.has(runtime)) {
      throw new ExecutionGateError(
        "runtime_quarantined",
        `runtime ${runtime} is quarantined pending backend stop confirmation`,
      );
    }
    if (signal.aborted) {
      throw new ExecutionGateError("request_cancelled", "request was cancelled while waiting");
    }
    if (this.exclusive) {
      throw new ExecutionGateError(
        "exclusive_execution",
        `exclusive execution is reserved by runtime ${this.exclusive.runtime}`,
        1,
      );
    }
    const state = this.runtimes.get(runtime) ?? { active: 0, queue: [] };
    this.runtimes.set(runtime, state);
    if (state.active < policy.maxConcurrentRequests) {
      state.active += 1;
      this.emit("execution_request", runtime, "started");
      this.emitState(runtime, state);
      return this.release(runtime, state, policy);
    }
    if (state.queue.length >= policy.maxQueuedRequests) {
      this.emit("execution_request", runtime, "queue_full");
      throw new ExecutionGateError(
        "queue_full",
        `runtime ${runtime} execution queue is full`,
        Math.max(1, Math.ceil(policy.queueTimeoutMs / 1_000)),
      );
    }

    this.emit("execution_request", runtime, "queued");
    return await new Promise<() => void>((resolve, reject) => {
      const entry = {} as QueueEntry;
      entry.resolve = resolve;
      entry.reject = reject;
      entry.signal = signal;
      entry.queuedAt = this.now();
      entry.priority = priority;
      this.sequence += 1;
      entry.sequence = this.sequence;
      entry.onAbort = () => {
        if (!this.removeQueued(state, entry)) {
          return;
        }
        reject(new ExecutionGateError("request_cancelled", "request was cancelled while waiting"));
        this.emit("execution_request", runtime, "cancelled");
        this.emitState(runtime, state);
      };
      entry.timeout = setTimeout(() => {
        if (!this.removeQueued(state, entry)) {
          return;
        }
        reject(new ExecutionGateError(
          "queue_timeout",
          `runtime ${runtime} execution queue wait exceeded ${policy.queueTimeoutMs}ms`,
          Math.max(1, Math.ceil(policy.queueTimeoutMs / 1_000)),
        ));
        this.emit("execution_request", runtime, "queue_timeout");
        this.emitState(runtime, state);
      }, policy.queueTimeoutMs);
      entry.timeout.unref?.();
      signal.addEventListener("abort", entry.onAbort, { once: true });
      state.queue.push(entry);
      state.queue.sort((left, right) =>
        right.priority - left.priority || left.sequence - right.sequence
      );
      this.emitState(runtime, state);
    });
  }

  async acquireExclusive(
    runtime: string,
    policy: ExecutionPolicy,
    signal: AbortSignal,
    priority = 0,
  ): Promise<() => void> {
    if (this.draining) {
      throw new ExecutionGateError("draining", "execution gate is draining");
    }
    if (this.quarantinedRuntimes.has(runtime)) {
      throw new ExecutionGateError(
        "runtime_quarantined",
        `runtime ${runtime} is quarantined pending backend stop confirmation`,
      );
    }
    if (signal.aborted) {
      throw new ExecutionGateError("request_cancelled", "request was cancelled while waiting");
    }
    if (this.exclusive) {
      throw new ExecutionGateError(
        "exclusive_execution",
        `exclusive execution is already reserved by runtime ${this.exclusive.runtime}`,
        1,
      );
    }

    const state = this.runtimes.get(runtime) ?? { active: 0, queue: [] };
    this.runtimes.set(runtime, state);
    return await new Promise<() => void>((resolve, reject) => {
      const entry: ExclusiveEntry = {
        runtime,
        policy,
        signal,
        priority,
        queuedAt: this.now(),
        phase: "pending",
        resolve,
        reject,
      };
      entry.onAbort = () => {
        if (this.exclusive !== entry || entry.phase !== "pending") return;
        this.clearExclusiveListeners(entry);
        this.exclusive = undefined;
        reject(new ExecutionGateError("request_cancelled", "request was cancelled while waiting"));
        this.resumeHeldPromotions();
      };
      entry.timeout = setTimeout(() => {
        if (this.exclusive !== entry || entry.phase !== "pending") return;
        this.clearExclusiveListeners(entry);
        this.exclusive = undefined;
        reject(new ExecutionGateError(
          "queue_timeout",
          `exclusive execution wait exceeded ${policy.queueTimeoutMs}ms`,
          Math.max(1, Math.ceil(policy.queueTimeoutMs / 1_000)),
        ));
        this.resumeHeldPromotions();
      }, policy.queueTimeoutMs);
      entry.timeout.unref?.();
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.exclusive = entry;
      this.emit("execution_request", runtime, "exclusive_pending", undefined, priority);
      this.promoteExclusive();
    });
  }

  tryAcquire(
    runtime: string,
    policy: ExecutionPolicy,
    signal: AbortSignal,
  ): (() => void) | undefined {
    if (this.draining || this.exclusive || this.quarantinedRuntimes.has(runtime) || signal.aborted) return undefined;
    const state = this.runtimes.get(runtime) ?? { active: 0, queue: [] };
    this.runtimes.set(runtime, state);
    if (state.active >= policy.maxConcurrentRequests) {
      this.emit("execution_request", runtime, "probe_busy");
      return undefined;
    }
    state.active += 1;
    this.emit("execution_request", runtime, "probe_started");
    this.emitState(runtime, state);
    return this.release(runtime, state, policy);
  }

  snapshot(runtime: string): { active: number; queued: number } {
    const state = this.runtimes.get(runtime);
    return { active: state?.active ?? 0, queued: state?.queue.length ?? 0 };
  }

  totals(): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    for (const state of this.runtimes.values()) {
      active += state.active;
      queued += state.queue.length;
    }
    return { active, queued: queued + (this.exclusive?.phase === "pending" ? 1 : 0) };
  }

  private release(runtime: string, state: RuntimeGate, policy: ExecutionPolicy): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      state.active = Math.max(0, state.active - 1);
      this.emit("execution_request", runtime, "completed");
      if (this.exclusive) {
        this.heldPromotions.set(runtime, { state, policy });
        this.promoteExclusive();
      } else {
        this.promote(runtime, state, policy);
      }
      this.emitState(runtime, state);
    };
  }

  private promoteExclusive(): void {
    const entry = this.exclusive;
    if (!entry || entry.phase !== "pending" || this.totals().active !== 0) return;
    this.clearExclusiveListeners(entry);
    entry.phase = "active";
    const state = this.runtimes.get(entry.runtime)!;
    state.active += 1;
    this.emit("execution_queue_seconds", entry.runtime, "exclusive_started", (this.now() - entry.queuedAt) / 1_000);
    this.emit("execution_request", entry.runtime, "exclusive_started", undefined, entry.priority);
    this.emitState(entry.runtime, state);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      if (this.exclusive === entry) this.exclusive = undefined;
      this.emit("execution_request", entry.runtime, "exclusive_completed");
      this.emitState(entry.runtime, state);
      this.resumeHeldPromotions();
    });
  }

  private clearExclusiveListeners(entry: ExclusiveEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }

  private resumeHeldPromotions(): void {
    const held = [...this.heldPromotions.entries()];
    this.heldPromotions.clear();
    for (const [runtime, { state, policy }] of held) {
      this.promote(runtime, state, policy);
      this.emitState(runtime, state);
    }
  }

  private promote(runtime: string, state: RuntimeGate, policy: ExecutionPolicy): void {
    while (!this.draining && !this.quarantinedRuntimes.has(runtime) && state.active < policy.maxConcurrentRequests) {
      const entry = state.queue.shift();
      if (!entry) {
        return;
      }
      this.removeEntryListeners(entry);
      if (entry.signal.aborted) {
        entry.reject(new ExecutionGateError("request_cancelled", "request was cancelled while waiting"));
        continue;
      }
      state.active += 1;
      this.emit("execution_queue_seconds", runtime, "started", (this.now() - entry.queuedAt) / 1_000);
      this.emit("execution_request", runtime, "started", undefined, entry.priority);
      entry.resolve(this.release(runtime, state, policy));
    }
  }

  private removeQueued(state: RuntimeGate, entry: QueueEntry): boolean {
    const index = state.queue.indexOf(entry);
    if (index < 0) {
      return false;
    }
    state.queue.splice(index, 1);
    this.removeEntryListeners(entry);
    return true;
  }

  private removeEntryListeners(entry: QueueEntry): void {
    clearTimeout(entry.timeout);
    entry.signal.removeEventListener("abort", entry.onAbort);
  }

  private emit(
    name: string,
    runtime: string,
    result: string,
    value?: number,
    priority?: number,
  ): void {
    this.options.onEvent?.({
      name,
      labels: { runtime, result, ...(priority === undefined ? {} : { priority: String(priority) }) },
      value,
    });
  }

  private emitState(runtime: string, state: RuntimeGate): void {
    this.options.onState?.(runtime, { active: state.active, queued: state.queue.length });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
