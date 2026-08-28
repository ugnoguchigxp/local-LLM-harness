import type { ControlEvent } from "./controller";

export type ExecutionPolicy = {
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  queueTimeoutMs: number;
};

export class ExecutionGateError extends Error {
  constructor(
    readonly code: "queue_full" | "queue_timeout" | "request_cancelled" | "draining",
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
  timeout: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

type RuntimeGate = { active: number; queue: QueueEntry[] };

export class ExecutionGate {
  private readonly runtimes = new Map<string, RuntimeGate>();
  private draining = false;

  constructor(
    private readonly options: {
      now?: () => number;
      onEvent?: (event: ControlEvent) => void;
      onState?: (runtime: string, state: { active: number; queued: number }) => void;
    } = {},
  ) {}

  beginDrain(): void {
    this.draining = true;
    for (const [runtime, state] of this.runtimes) {
      for (const entry of state.queue.splice(0)) {
        this.removeEntryListeners(entry);
        entry.reject(new ExecutionGateError("draining", "execution gate is draining"));
        this.emit("execution_request", runtime, "draining");
      }
      this.emitState(runtime, state);
    }
  }

  async acquire(
    runtime: string,
    policy: ExecutionPolicy,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (this.draining) {
      throw new ExecutionGateError("draining", "execution gate is draining");
    }
    if (signal.aborted) {
      throw new ExecutionGateError("request_cancelled", "request was cancelled while waiting");
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
      this.emitState(runtime, state);
    });
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
    return { active, queued };
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
      this.promote(runtime, state, policy);
      this.emitState(runtime, state);
    };
  }

  private promote(runtime: string, state: RuntimeGate, policy: ExecutionPolicy): void {
    while (!this.draining && state.active < policy.maxConcurrentRequests) {
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
      this.emit("execution_request", runtime, "started");
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

  private emit(name: string, runtime: string, result: string, value?: number): void {
    this.options.onEvent?.({ name, labels: { runtime, result }, value });
  }

  private emitState(runtime: string, state: RuntimeGate): void {
    this.options.onState?.(runtime, { active: state.active, queued: state.queue.length });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
