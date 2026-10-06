import { spawn } from "node:child_process";

export type MediaVariant = "image" | "music";

export class MediaVariantStopError extends Error {
  constructor(readonly variant: MediaVariant, cause: unknown) {
    super(`${variant} worker shutdown failed`, { cause });
  }
}

export class MediaVariantBusyError extends Error {
  constructor() {
    super("another media variant is active");
    this.name = "MediaVariantBusyError";
  }
}

async function runVariantScript(script: string, action: "start" | "stop", variant: MediaVariant, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(script, [action, variant], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 5_000);
        killTimer.unref();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("close", () => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`${variant} ${action} failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}

export class MediaVariantManager {
  private active: Record<MediaVariant, number> = { image: 0, music: 0 };
  private warm: Record<MediaVariant, boolean> = { image: false, music: false };
  private timers: Partial<Record<MediaVariant, ReturnType<typeof setTimeout>>> = {};
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private faulted = false;
  private waitingMusic = 0;
  private starting = false;
  private readonly shutdown = new AbortController();

  isOccupied(): boolean { return this.starting || this.faulted || this.active.image > 0 || this.active.music > 0 || this.warm.image || this.warm.music; }

  get available(): boolean { return !this.closed && !this.faulted; }

  constructor(private readonly options: {
    script: string;
    idleTtlMs: Record<MediaVariant, number>;
    beforeStart?: () => void;
    run?: (action: "start" | "stop", variant: MediaVariant, signal?: AbortSignal) => Promise<void>;
  }) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async acquire(variant: MediaVariant, signal?: AbortSignal): Promise<() => Promise<void>> {
    await this.serialized(async () => {
      if (this.closed) throw new Error("media variant manager is closed");
      signal?.throwIfAborted();
      if (this.faulted) throw new Error("media worker stop failed; runtime is quarantined");
      if (this.options.idleTtlMs[variant] === 0 && (this.active.image + this.active.music) > 0) throw new MediaVariantBusyError();
      if (variant === "image" && this.waitingMusic > 0) throw new MediaVariantBusyError();
      const other = variant === "image" ? "music" : "image";
      if (this.active[other] > 0) throw new MediaVariantBusyError();
      const timer = this.timers[variant];
      if (timer) clearTimeout(timer);
      delete this.timers[variant];
      if (this.active[variant] === 0) {
        this.options.beforeStart?.();
        // The script verifies health even for an already running worker. A
        // failed switch may have stopped the previous worker before failing.
        this.warm[variant] = false;
        this.warm[other] = false;
        const otherTimer = this.timers[other];
        if (otherTimer) clearTimeout(otherTimer);
        delete this.timers[other];
        this.starting = true;
        try {
          await this.run("start", variant, AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]));
          signal?.throwIfAborted();
          if (this.closed) throw new Error("media variant manager is closed");
        } catch (error) {
          await this.stop(variant);
          throw error;
        } finally { this.starting = false; }
        this.warm[variant] = true;
      }
      if (this.closed) throw new Error("media variant manager is closed");
      this.active[variant]++;
    });
    let releasePromise: Promise<void> | undefined;
    return () => {
      if (releasePromise) return releasePromise;
      releasePromise = this.serialized(async () => {
        this.active[variant]--;
        if (this.active[variant] !== 0) return;
        if (this.closed || this.options.idleTtlMs[variant] === 0) {
          if (this.warm[variant]) await this.stop(variant);
          return;
        }
        const timer = setTimeout(() => {
          delete this.timers[variant];
          void this.serialized(async () => {
            if (!this.closed && this.active[variant] === 0 && this.warm[variant]) {
              await this.stop(variant);
            }
          }).catch((error) => console.error(`media variant idle stop failed: ${String(error)}`));
        }, this.options.idleTtlMs[variant]);
        timer.unref?.();
        this.timers[variant] = timer;
      });
      return releasePromise;
    };
  }

  async waitForMusic(signal: AbortSignal, timeoutMs = 300_000): Promise<() => Promise<void>> {
    this.waitingMusic++;
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        signal.throwIfAborted();
        try { return await this.acquire("music", signal); }
        catch (error) {
          if (!(error instanceof MediaVariantBusyError)) throw error;
          if (Date.now() >= deadline) throw new Error("media execution capacity wait expired");
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 100);
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      }
    } finally { this.waitingMusic--; }
  }

  quarantine(): void { this.faulted = true; }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(new Error("media manager closed"));
    for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer);
    this.timers = {};
    await this.serialized(async () => {
      for (const variant of ["image", "music"] as const) {
        if (this.warm[variant]) await this.stop(variant);
      }
    });
  }

  private async stop(variant: MediaVariant): Promise<void> {
    try {
      await this.run("stop", variant);
      this.warm[variant] = false;
    } catch (error) {
      this.faulted = true;
      throw new MediaVariantStopError(variant, error);
    }
  }

  private run(action: "start" | "stop", variant: MediaVariant, signal?: AbortSignal): Promise<void> {
    return this.options.run?.(action, variant, signal)
      ?? runVariantScript(this.options.script, action, variant, signal);
  }
}
