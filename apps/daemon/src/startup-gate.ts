/** Serializes physical loading, without reserving bytes or serializing warm inference. */
export class StartupGate {
  private active = false;
  private closed = false;
  private readonly queue: { signal?: AbortSignal; grant: () => void; reject: (reason: unknown) => void; abort: () => void }[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("startup gate is closed"));
    return new Promise((resolve, reject) => {
      const entry = { signal, reject, abort: () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal!.reason);
      }, grant: () => {
        signal?.removeEventListener("abort", entry.abort);
        this.active = true;
        let released = false;
        resolve(() => { if (released) return; released = true; this.active = false; this.next(); });
      } };
      if (!this.active) entry.grant();
      else { this.queue.push(entry); signal?.addEventListener("abort", entry.abort, { once: true }); }
    });
  }

  private next(): void {
    if (this.closed || this.active) return;
    this.queue.shift()?.grant();
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { signal?.throwIfAborted(); return await work(); }
    finally { release(); }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(new Error("startup gate is closed"));
    }
  }
}
