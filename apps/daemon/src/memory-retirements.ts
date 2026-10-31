type Retirement = {
  abort: AbortController;
  step?: Promise<void>;
  attempt: () => void;
};

/** Keep a selected runtime draining after the admitting HTTP request returns. */
export class MemoryRetirements {
  private readonly pending = new Map<string, Retirement>();
  private chain: Promise<void> = Promise.resolve();

  async run(input: {
    runtimeId: string;
    timeoutMs: number;
    retryMs: number;
    signal?: AbortSignal;
    eligible: () => boolean;
    busy: () => boolean;
    retire: () => Promise<boolean | "busy">;
    release: () => void;
  }): Promise<boolean> {
    const abort = new AbortController();
    const signal = input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal;
    const completion = Promise.withResolvers<boolean>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let running = false;
    const finish = (result: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(retry);
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(input.runtimeId);
      input.release();
      completion.resolve(result);
    };
    const schedule = () => {
      if (signal.aborted) return finish(false);
      clearTimeout(retry);
      retry = setTimeout(() => entry.attempt(), Math.max(25, input.retryMs));
      retry.unref?.();
    };
    const entry: Retirement = {
      abort,
      attempt: () => {
        if (finished || entry.step) return;
        if (signal.aborted || !input.eligible()) return finish(false);
        if (input.busy()) return schedule();
        clearTimeout(retry);
        entry.step = this.chain.then(() => {
          signal.throwIfAborted();
          running = true;
          return input.retire();
        }).then(result => {
          if (result === "busy") schedule();
          else finish(result);
        }).catch(() => finish(false)).finally(() => { running = false; entry.step = undefined; });
        this.chain = entry.step;
      },
    };
    const onAbort = () => { if (!running) finish(false); };
    signal.addEventListener("abort", onAbort, { once: true });
    this.pending.set(input.runtimeId, entry);
    entry.attempt();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion.promise,
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, input.timeoutMs)); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  notify(): void {
    for (const entry of this.pending.values()) {
      entry.attempt();
    }
  }

  async flush(): Promise<void> {
    // A flush waits for stop attempts, never for unfinished inference.
    await Promise.allSettled([...this.pending.values()].flatMap(entry => entry.step ? [entry.step] : []));
  }

  close(): void {
    for (const entry of this.pending.values()) entry.abort.abort(new Error("control plane is draining"));
  }
}
