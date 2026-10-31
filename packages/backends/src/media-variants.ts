import { spawn } from "node:child_process";

export type MediaVariant = "image" | "image-flux3" | "music" | "mesh" | "stable-audio";

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
  private active: Record<MediaVariant, number> = { image: 0, "image-flux3": 0, music: 0, mesh: 0, "stable-audio": 0 };
  private warm: Record<MediaVariant, boolean> = { image: false, "image-flux3": false, music: false, mesh: false, "stable-audio": false };
  private timers: Partial<Record<MediaVariant, ReturnType<typeof setTimeout>>> = {};
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private faulted = false;
  private waiters: symbol[] = [];
  private starting = false;
  private readonly shutdown = new AbortController();

  isOccupied(): boolean { return this.starting || this.faulted || Object.values(this.active).some(Boolean) || Object.values(this.warm).some(Boolean); }

  get available(): boolean { return !this.closed && !this.faulted; }

  constructor(private readonly options: {
    script: string;
    idleTtlMs: { image: number; music: number; "image-flux3"?: number; mesh?: number; "stable-audio"?: number };
    beforeStart?: (variant: MediaVariant) => void;
    afterStart?: (variant: MediaVariant) => void;
    afterStop?: (variant: MediaVariant) => void;
    run?: (action: "start" | "stop", variant: MediaVariant, signal?: AbortSignal) => Promise<void>;
  }) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async acquire(variant: MediaVariant, signal?: AbortSignal, ticket?: symbol, deadline?: number): Promise<() => Promise<void>> {
    await this.serialized(async () => {
      if (this.closed) throw new Error("media variant manager is closed");
      signal?.throwIfAborted();
      if (this.faulted) throw new Error("media worker stop failed; runtime is quarantined");
      // The serialized queue may have waited for a previous worker to stop.
      if (deadline !== undefined && Date.now() >= deadline) throw new Error("media execution capacity wait expired");
      if ((this.options.idleTtlMs[variant] ?? 0) === 0 && Object.values(this.active).reduce((a, b) => a + b, 0) > 0) throw new MediaVariantBusyError();
      if (this.waiters.length > 0 && ticket !== this.waiters[0]) throw new MediaVariantBusyError();
      const others = (["image", "image-flux3", "music", "mesh", "stable-audio"] as const).filter((v) => v !== variant);
      if (others.some((v) => this.active[v] > 0)) throw new MediaVariantBusyError();
      const timer = this.timers[variant];
      if (timer) clearTimeout(timer);
      delete this.timers[variant];
      if (this.active[variant] === 0) {
        this.options.beforeStart?.(variant);
        // The script verifies health even for an already running worker. A
        // failed switch may have stopped the previous worker before failing.
        this.warm[variant] = false;
        for (const other of others) {
          if (this.warm[other]) await this.stop(other);
          const timer = this.timers[other];
          if (timer) clearTimeout(timer);
          delete this.timers[other];
        }
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
        this.options.afterStart?.(variant);
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
        if (this.closed || (this.options.idleTtlMs[variant] ?? 0) === 0) {
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

  async waitForMusic(signal: AbortSignal, timeoutMs = 300_000, variant: "music" | "stable-audio" = "music"): Promise<() => Promise<void>> {
    return this.waitFor(variant, signal, timeoutMs);
  }

  async waitFor(variant: MediaVariant, signal: AbortSignal, timeoutMs = 600_000): Promise<() => Promise<void>> {
    const ticket = Symbol();
    this.waiters.push(ticket);
    const deadline = Date.now() + timeoutMs;
    let firstAttempt = true;
    try {
      while (true) {
        signal.throwIfAborted();
        if (!firstAttempt && Date.now() >= deadline) throw new Error("media execution capacity wait expired");
        firstAttempt = false;
        try {
          if (this.waiters[0] !== ticket) throw new MediaVariantBusyError();
          return await this.acquire(variant, signal, ticket, timeoutMs > 0 ? deadline : undefined);
        }
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
    } finally { this.waiters = this.waiters.filter((v) => v !== ticket); }
  }

  quarantine(): void { this.faulted = true; }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(new Error("media manager closed"));
    for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer);
    this.timers = {};
    await this.serialized(async () => {
      for (const variant of ["image", "image-flux3", "music", "mesh", "stable-audio"] as const) {
        if (this.warm[variant]) await this.stop(variant);
      }
    });
  }

  private async stop(variant: MediaVariant): Promise<void> {
    try {
      await this.run("stop", variant);
      this.warm[variant] = false;
      this.options.afterStop?.(variant);
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
