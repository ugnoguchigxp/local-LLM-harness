import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const snapshotSchema = z.object({
  version: z.literal(1), catalogRevision: z.string().min(1).max(128),
  runtimeIds: z.array(z.string().min(1).max(128)).max(32),
  protectedConsumer: z.boolean(),
}).strict();
export type UsageRetentionSnapshot = z.infer<typeof snapshotSchema>;

/** One coalesced asynchronous writer; no request content or credentials are persisted. */
export class LocalUsageRetentionStore {
  private pending?: UsageRetentionSnapshot;
  private writing?: Promise<void>;
  private saved?: string;
  failed = false;
  constructor(private readonly path: string) {}
  async load(): Promise<UsageRetentionSnapshot | undefined> {
    try {
      if ((await stat(this.path)).size > 16_384) throw new Error("usage retention snapshot is too large");
      return snapshotSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      this.failed = true;
      throw new Error("invalid usage retention snapshot");
    }
  }
  save(snapshot: UsageRetentionSnapshot): void {
    const parsed = snapshotSchema.parse(snapshot);
    if (JSON.stringify(parsed) === this.saved && !this.pending && !this.writing) return;
    this.pending = parsed;
    if (!this.writing) this.startWriter();
  }
  async flush(): Promise<void> { while (this.writing) await this.writing; }
  private startWriter(): void {
    this.writing = this.drain().finally(() => {
      this.writing = undefined;
      // A save can arrive after drain exits but before this finalizer runs.
      if (this.pending) this.startWriter();
    });
  }
  private async drain(): Promise<void> {
    while (this.pending) {
      const data = JSON.stringify(this.pending);
      this.pending = undefined;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, data, { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
        this.saved = data;
        this.failed = false;
      } catch {
        this.failed = true;
        await unlink(`${this.path}.tmp`).catch(() => undefined);
      }
    }
  }
}
