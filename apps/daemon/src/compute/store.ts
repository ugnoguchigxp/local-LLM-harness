import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { COMPUTE_LIMITS, ComputeError, type ComputeJob, type ComputeRequest } from "@larm/core";

export type ComputeRecord = { id: string; principal: string; key: string; hash: string; state: string;
  request: string | null; deleted: number; receiptUntil: number; reserved: number; bytes: number;
  status: ComputeJob["status"]; queuedAt: string; expiresAt: string | null };

/** Domain-owned store. Code/inputs disappear on terminal transition; artifacts are atomic with the result. */
export class ComputeStore {
  readonly db: Database;
  private closed = false;
  constructor(root: string, private readonly onFault: () => void = () => {}) {
    if (!isAbsolute(root)) throw new Error("Compute state requires an absolute directory");
    root = resolve(root);
    if (root === "/") throw new Error("Compute state requires a dedicated directory");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    root = realpathSync(root);
    if (root === "/") throw new Error("Compute state requires a dedicated directory");
    chmodSync(root, 0o700);
    const path = join(root, "compute.sqlite");
    for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Compute database files must not be symlinks");
    }
    this.db = new Database(path, { create: true, strict: true });
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE;
      BEGIN EXCLUSIVE; COMMIT; PRAGMA max_page_count=65536;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL,
        state TEXT NOT NULL, request TEXT, deleted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, queuedAt TEXT NOT NULL, expiresAt TEXT,
        receiptUntil INTEGER NOT NULL, reserved INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(principal,key));
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, jobId TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS artifact_job ON artifacts(jobId);`);
    } catch {
      this.db.close(); this.closed = true; this.onFault();
      throw new ComputeError("unavailable", "Compute storage initialization failed", 503);
    }
  }
  private access<T>(action: () => T): T {
    try { return action(); } catch {
      this.onFault();
      throw new ComputeError("unavailable", "Compute storage is unavailable", 503);
    }
  }
  record(id: string): ComputeRecord | null { return this.access(() => this.db.query<ComputeRecord, [string]>("SELECT * FROM jobs WHERE id=?").get(id)); }
  replay(principal: string, key: string): ComputeRecord | null {
    return this.access(() => this.db.query<ComputeRecord, [string, string]>("SELECT * FROM jobs WHERE principal=? AND key=?").get(principal, key));
  }
  records(): ComputeRecord[] { return this.access(() => this.db.query<ComputeRecord, []>("SELECT * FROM jobs ORDER BY rowid").all()); }
  summaries(): Omit<ComputeRecord, "state" | "request">[] {
    return this.access(() => this.db.query<Omit<ComputeRecord, "state" | "request">, []>("SELECT id,principal,key,hash,deleted,receiptUntil,reserved,bytes,status,queuedAt,expiresAt FROM jobs ORDER BY rowid").all());
  }
  nextQueued(): ComputeRecord | null {
    return this.access(() => this.db.query<ComputeRecord, []>("SELECT * FROM jobs WHERE deleted=0 AND status='queued' ORDER BY rowid LIMIT 1").get());
  }
  add(job: ComputeJob, principal: string, key: string, hash: string, request: ComputeRequest, now: number, reserved: number): void {
    this.access(() => this.db.query("INSERT INTO jobs(id,principal,key,hash,state,request,receiptUntil,reserved,status,queuedAt) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(job.jobId, principal, key, hash, JSON.stringify(job), JSON.stringify(request), now + COMPUTE_LIMITS.idempotencyRetentionSec * 1000, reserved, job.status, job.queuedAt));
  }
  save(job: ComputeJob): void {
    const terminal = job.status !== "queued" && job.status !== "running";
    const state = JSON.stringify(job);
    this.access(() => this.db.query(`UPDATE jobs SET state=?,status=?,expiresAt=?,bytes=?,request=CASE WHEN ? THEN NULL ELSE request END,
      reserved=CASE WHEN ? THEN 0 ELSE reserved END WHERE id=?`).run(state, job.status, job.expiresAt, Buffer.byteLength(state), terminal ? 1 : 0, terminal ? 1 : 0, job.jobId));
  }
  complete(job: ComputeJob, artifacts: Array<{ id: string; mime: string; data: Uint8Array }>): void {
    this.access(() => this.db.transaction(() => {
      this.save(job);
      for (const artifact of artifacts) this.db.query("INSERT INTO artifacts(id,jobId,mime,data) VALUES(?,?,?,?)")
        .run(artifact.id, job.jobId, artifact.mime, artifact.data);
      const bytes = Buffer.byteLength(JSON.stringify(job)) + artifacts.reduce((sum, item) => sum + item.data.byteLength, 0);
      this.db.query("UPDATE jobs SET bytes=? WHERE id=?").run(bytes, job.jobId);
    })());
  }
  remove(record: ComputeRecord): void {
    this.access(() => this.db.transaction(() => {
      this.db.query("DELETE FROM artifacts WHERE jobId=?").run(record.id);
      const state = JSON.parse(record.state) as ComputeJob;
      delete state.result; delete state.progress; delete state.error;
      const json = JSON.stringify(state);
      this.db.query("UPDATE jobs SET deleted=1,request=NULL,state=?,reserved=0,bytes=? WHERE id=?").run(json, Buffer.byteLength(json), record.id);
    })());
  }
  artifact(jobId: string, id: string): { mime: string; data: Uint8Array } | null {
    return this.access(() => this.db.query<{ mime: string; data: Uint8Array }, [string, string]>("SELECT mime,data FROM artifacts WHERE jobId=? AND id=?").get(jobId, id));
  }
  pruneReceipts(now: number): void {
    this.access(() => this.db.query("DELETE FROM jobs WHERE deleted=1 AND receiptUntil<=?").run(now));
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
