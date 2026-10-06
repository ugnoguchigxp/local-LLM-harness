import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, this.path);
  }
}
