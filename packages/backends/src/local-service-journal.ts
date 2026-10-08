import { mkdir, readFile, rename, writeFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalServiceJournal } from "@larm/core";

export class LocalServiceFileJournal implements LocalServiceJournal {
  constructor(private readonly path: string) {}
  async load(): Promise<unknown | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (raw.length > 65536) throw new Error("journal_too_large");
      return JSON.parse(raw);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async save(value: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Preserve the exact original journal once before a v1 -> v2 migration.
    try {
      const original = await readFile(this.path, "utf8");
      if (JSON.parse(original).version === 1 && (value as { version?: number }).version === 2) {
        try { await writeFile(`${this.path}.v1.bak`, original, { mode: 0o600, flag: "wx" }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        const backup = await open(`${this.path}.v1.bak`, "r");
        try { await backup.sync(); } finally { await backup.close(); }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const temp = `${this.path}.tmp`;
    const file = await open(temp, "w", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, this.path);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
