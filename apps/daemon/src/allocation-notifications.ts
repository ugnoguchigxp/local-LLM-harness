import type { Allocation } from "@larm/core";

/** Notifications are independent of telemetry sinks and never hold an allocation. */
export class AllocationNotifications {
  private readonly listeners = new Map<string, Set<() => void>>();
  get size(): number { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
  notify(id: string): void {
    for (const listener of [...(this.listeners.get(id) ?? [])]) listener();
  }
  wait(id: string, read: () => Allocation | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<Allocation | undefined> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const set = this.listeners.get(id) ?? new Set();
      this.listeners.set(id, set);
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        set.delete(changed);
        if (!set.size && this.listeners.get(id) === set) this.listeners.delete(id);
      };
      const finish = (error?: unknown, allocation?: Allocation) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(allocation);
      };
      const aborted = () => finish(signal?.reason ?? new Error("allocation wait aborted"));
      const changed = () => {
        try {
          const allocation = read();
          if (!allocation || !["pending", "waiting"].includes(allocation.status)) finish(undefined, allocation);
        } catch (error) { finish(error); }
      };
      set.add(changed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) return aborted();
      // Subscribe before reading: a synchronous state change cannot be missed.
      changed();
      if (!settled) {
        timer = setTimeout(() => { try { finish(undefined, read()); } catch (error) { finish(error); } }, Math.max(0, timeoutMs));
        timer.unref?.();
      }
    });
  }
}
