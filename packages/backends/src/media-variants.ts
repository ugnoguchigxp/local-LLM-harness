import { spawn } from "node:child_process";

export type MediaVariant = "image" | "music";

export class MediaVariantBusyError extends Error {
  constructor() {
    super("another media variant is active");
    this.name = "MediaVariantBusyError";
  }
}

async function runVariantScript(script: string, action: "start" | "stop", variant: MediaVariant): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(script, [action, variant], { stdio: ["ignore", "ignore", "pipe"] });
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

  constructor(private readonly options: {
    script: string;
    idleTtlMs: Record<MediaVariant, number>;
    run?: (action: "start" | "stop", variant: MediaVariant) => Promise<void>;
  }) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async acquire(variant: MediaVariant): Promise<() => void> {
    await this.serialized(async () => {
      const other = variant === "image" ? "music" : "image";
      if (this.active[other] > 0) throw new MediaVariantBusyError();
      const timer = this.timers[variant];
      if (timer) clearTimeout(timer);
      delete this.timers[variant];
      if (!this.warm[variant]) {
        await this.run("start", variant);
        this.warm[variant] = true;
        this.warm[other] = false;
        const otherTimer = this.timers[other];
        if (otherTimer) clearTimeout(otherTimer);
        delete this.timers[other];
      }
      this.active[variant]++;
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      void this.serialized(async () => {
        this.active[variant]--;
        if (this.active[variant] !== 0) return;
        const timer = setTimeout(() => {
          delete this.timers[variant];
          void this.serialized(async () => {
            if (this.active[variant] === 0 && this.warm[variant]) {
              await this.run("stop", variant);
              this.warm[variant] = false;
            }
          }).catch((error) => console.error(`media variant idle stop failed: ${String(error)}`));
        }, this.options.idleTtlMs[variant]);
        timer.unref?.();
        this.timers[variant] = timer;
      });
    };
  }

  close(): void {
    for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer);
    this.timers = {};
  }

  private run(action: "start" | "stop", variant: MediaVariant): Promise<void> {
    return this.options.run?.(action, variant)
      ?? runVariantScript(this.options.script, action, variant);
  }
}
