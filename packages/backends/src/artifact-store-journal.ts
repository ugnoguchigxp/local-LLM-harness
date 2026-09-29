import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ArtifactStoreError } from "./artifact-store-errors";
import { SAFE_ARTIFACT_ID } from "./artifact-store-safety";

export type PreviousTarget =
  | { kind: "hardlink"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "symlink"; path: string }
  | { kind: "none" };

export type ActivationRecord = {
  artifactKind: "file" | "snapshot";
  artifactDigest: string;
  phase: "prepared" | "active";
  artifactId: string;
  revision: string;
  target: string;
  activePath: string;
  previous: PreviousTarget;
  activatedAt: string;
};

export type ArtifactJournalRecord = Record<string, unknown> & {
  id: string;
  status: string;
};

export type ArtifactStoreJournalOptions = {
  stateRoot: string;
  stagingRoot: string;
  rollbackRoot: string;
  now?: () => number;
  random?: () => string;
};

export class ArtifactStoreJournal {
  constructor(private readonly options: ArtifactStoreJournalOptions) {}

  async writeOperation(record: ArtifactJournalRecord): Promise<void> {
    this.assertSafeId(record.id, "unsafe_operation_id", "operation id is not safe");
    const directory = await this.stateDirectory("operations", "artifact operation");
    await this.writeJsonAtomic(join(directory, `${record.id}.json`), record);
  }

  async loadOperations(): Promise<ArtifactJournalRecord[]> {
    const directory = await this.stateDirectory("operations", "artifact operation");
    const glob = new Bun.Glob("*.json");
    const records: ArtifactJournalRecord[] = [];
    try {
      for await (const path of glob.scan({ cwd: directory, absolute: true })) {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
          throw new ArtifactStoreError("journal_corrupt", `unsafe operation journal ${path}`);
        }
        const record = JSON.parse(await readFile(path, "utf8")) as Partial<ArtifactJournalRecord>;
        if (
          typeof record.id !== "string"
          || !SAFE_ARTIFACT_ID.test(record.id)
          || typeof record.status !== "string"
          || basename(path) !== `${record.id}.json`
        ) {
          throw new ArtifactStoreError("journal_corrupt", `invalid operation journal ${path}`);
        }
        records.push(record as ArtifactJournalRecord);
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    return records;
  }

  async deleteOperation(id: string): Promise<void> {
    this.assertSafeId(id, "unsafe_operation_id", "operation id is not safe");
    const directory = await this.stateDirectory("operations", "artifact operation");
    await rm(join(directory, `${id}.json`), { force: true });
  }

  async writeActivation(record: ActivationRecord): Promise<void> {
    this.assertSafeId(record.artifactId, "unsafe_path", "artifact id is not safe for activation journal");
    const directory = await this.stateDirectory("activations", "artifact activation");
    await this.writeJsonAtomic(join(directory, `${record.artifactId}.json`), record);
  }

  async readActivation(id: string): Promise<ActivationRecord | undefined> {
    this.assertSafeId(id, "unsafe_path", "artifact id is not safe for activation journal");
    try {
      const directory = await this.stateDirectory("activations", "artifact activation");
      const path = join(directory, `${id}.json`);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
        throw new ArtifactStoreError("journal_corrupt", `unsafe activation journal for ${id}`);
      }
      const record = JSON.parse(await readFile(path, "utf8")) as Partial<ActivationRecord>;
      if (
        record.artifactId !== id
        || !["file", "snapshot"].includes(record.artifactKind ?? "")
        || !["prepared", "active"].includes(record.phase ?? "")
        || typeof record.artifactDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(record.artifactDigest)
        || typeof record.revision !== "string"
        || typeof record.target !== "string"
        || !isAbsolute(record.target)
        || typeof record.activePath !== "string"
        || !this.withinRoot(this.options.stagingRoot, record.activePath)
        || !record.previous
        || !["hardlink", "directory", "symlink", "none"].includes(record.previous.kind)
        || (record.previous.kind !== "none" && typeof record.previous.path !== "string")
        || ((record.previous.kind === "hardlink" || record.previous.kind === "directory")
          && !this.withinRoot(this.options.rollbackRoot, record.previous.path))
        || typeof record.activatedAt !== "string"
      ) {
        throw new ArtifactStoreError("journal_corrupt", `invalid activation journal for ${id}`);
      }
      return record as ActivationRecord;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async deleteActivation(id: string): Promise<void> {
    this.assertSafeId(id, "unsafe_path", "artifact id is not safe for activation journal");
    const directory = await this.stateDirectory("activations", "artifact activation");
    await rm(join(directory, `${id}.json`), { force: true });
  }

  private async stateDirectory(name: "operations" | "activations", description: string): Promise<string> {
    const stateRoot = resolve(this.options.stateRoot);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stateMetadata = await lstat(stateRoot);
    if (
      !stateMetadata.isDirectory()
      || stateMetadata.isSymbolicLink()
      || await realpath(stateRoot) !== stateRoot
    ) {
      throw new ArtifactStoreError("journal_corrupt", "artifact state root is unsafe");
    }
    const directory = join(stateRoot, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ArtifactStoreError("journal_corrupt", `${description} directory is unsafe`);
    }
    return directory;
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp-${this.random()}`;
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await output.writeFile(`${JSON.stringify(value)}\n`);
      await output.sync();
      await output.close();
      output = undefined;
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } catch (err) {
      await output?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw err;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private withinRoot(root: string, path: string): boolean {
    if (!isAbsolute(path)) return false;
    const child = relative(resolve(root), resolve(path));
    return child !== "" && child !== ".."
      && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(child);
  }

  private assertSafeId(id: string, code: "unsafe_operation_id" | "unsafe_path", message: string): void {
    if (!SAFE_ARTIFACT_ID.test(id)) throw new ArtifactStoreError(code, message);
  }

  private random(): string {
    return (this.options.random ?? (() => crypto.randomUUID()))();
  }
}
