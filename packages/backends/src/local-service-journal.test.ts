import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalServiceFileJournal } from "./local-service-journal";

test("v2 migration preserves exact v1 bytes, never replaces backup, and refuses corrupt originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-journal-"));
  try {
    const path = join(root, "state.json"), journal = new LocalServiceFileJournal(path);
    const original = '{ "version": 1, "entries": [] }\n';
    await writeFile(path, original);
    await journal.save({ version: 2, entries: [] });
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
    await journal.save({ version: 2, entries: [{ id: "fixture" }] });
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
    expect(await journal.load()).toEqual({ version: 2, entries: [{ id: "fixture" }] });
    await writeFile(path, "corrupt evidence");
    await expect(journal.save({ version: 2, entries: [] })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corrupt evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
