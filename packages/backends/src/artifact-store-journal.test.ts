import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStoreJournal } from "./artifact-store-journal";

test("artifact operation journal uses the secure default temporary-name source", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-artifact-journal-"));
  try {
    const journal = new ArtifactStoreJournal({
      stateRoot: join(root, "state"),
      stagingRoot: join(root, "staging"),
      rollbackRoot: join(root, "rollback"),
    });
    await journal.writeOperation({ id: "operation-1", status: "pending" });
    expect(await journal.loadOperations()).toEqual([{ id: "operation-1", status: "pending" }]);
    await journal.deleteOperation("operation-1");
    expect(await journal.loadOperations()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
