import { execFile } from "node:child_process";
import { parseKernelMonitoringFact, type KernelMonitoringFact } from "./linux-monitoring";
import type { MonitoringCoverage } from "@larm/core";

export class KernelMonitoringReader {
  private cursor?: string;
  private flight?: Promise<{ facts: KernelMonitoringFact[]; coverage: MonitoringCoverage }>;
  private since: string | null = null;
  private through: string | null = null;
  private readonly seen = new Map<string, number>();
  constructor(private readonly options: { now?: () => number; run?: (args: string[]) => Promise<{ stdout: string; stderr: string }> } = {}) {}
  read(): Promise<{ facts: KernelMonitoringFact[]; coverage: MonitoringCoverage }> {
    if (this.flight) return this.flight;
    this.flight = this.collect().finally(() => { this.flight = undefined; }); return this.flight;
  }
  private async collect(): Promise<{ facts: KernelMonitoringFact[]; coverage: MonitoringCoverage }> {
    const now = this.options.now?.() ?? Date.now(), at = new Date(now).toISOString();
    const coverage = (status: MonitoringCoverage["status"], reasonCode: string | null): MonitoringCoverage => ({ id: "kernel_events", status, reasonCode, since: this.since, through: this.through });
    try {
      const args = ["-k", "--no-pager", "--output=json", "--lines=5001", ...(this.cursor ? [`--after-cursor=${this.cursor}`] : ["--since=-10min"])];
      const result = await (this.options.run ? this.options.run(args) : new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile("journalctl", args, { timeout: 1000, maxBuffer: 1_048_576, encoding: "utf8" }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(new Error("journal_read_failed"), { code: /permission|not seeing messages|failed to open/i.test(stderr) ? "EACCES" : (error as NodeJS.ErrnoException).code }));
          else resolve({ stdout, stderr });
        });
      }));
      if (/permission|not seeing messages|failed to open/i.test(result.stderr)) throw Object.assign(new Error("journal_access_denied"), { code: "EACCES" });
      if (/cursor|seek/i.test(result.stderr)) throw Object.assign(new Error("journal_cursor_lost"), { code: "ECURSOR" });
      const lines = result.stdout.split("\n").filter(Boolean), facts: KernelMonitoringFact[] = [];
      let invalid = false;
      for (const line of lines) {
        let record: Record<string, unknown>;
        try { record = JSON.parse(line); } catch { invalid = true; continue; }
        if (typeof record.__CURSOR !== "string" || typeof record.__REALTIME_TIMESTAMP !== "string") { invalid = true; continue; }
        this.cursor = record.__CURSOR;
        const fact = parseKernelMonitoringFact(record);
        if (fact?.sourceEventId && !this.seen.has(fact.sourceEventId)) {
          facts.push(fact);
          if (this.seen.size >= 100_000) this.seen.delete(this.seen.keys().next().value!);
          this.seen.set(fact.sourceEventId, now);
        }
      }
      for (const [id, when] of this.seen) if (now - when > 600_000) this.seen.delete(id);
      if (lines.length >= 5001 || invalid) { this.since = null; this.through = null; return { facts, coverage: coverage("error", lines.length >= 5001 ? "journal_limit_exceeded" : "journal_record_invalid") }; }
      this.since ??= this.through ?? new Date(now - 600_000).toISOString(); this.through = at;
      return { facts, coverage: coverage("available", null) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A lost cursor cannot silently turn into an empty successful interval.
      this.cursor = undefined; this.since = null; this.through = null;
      return { facts: [], coverage: coverage(code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ENOENT" ? "unsupported" : "error", code === "EACCES" || code === "EPERM" ? "journal_access_denied" : code === "ECURSOR" ? "journal_cursor_lost" : "journal_read_failed") };
    }
  }
}
