import { ComputeError } from "@larm/core";

/** Collect each line once. Re-concatenating a growing PNG frame is quadratic. */
export class ComputeJsonLines {
  private chunks: Buffer[] = [];
  private length = 0;
  private total = 0;
  constructor(private readonly limits = { frame: 8 * 1024 * 1024, total: 80 * 1024 * 1024 }) {}

  push(part: Buffer, receive: (value: unknown) => void): void {
    this.total += part.length;
    if (this.total > this.limits.total) throw new ComputeError("output_exceeded");
    let offset = 0;
    while (offset < part.length) {
      const newline = part.indexOf(10, offset);
      const end = newline === -1 ? part.length : newline;
      const piece = part.subarray(offset, end);
      this.length += piece.length;
      if (this.length > this.limits.frame) throw new ComputeError("output_exceeded");
      if (piece.length) this.chunks.push(piece);
      if (newline === -1) return;
      const line = Buffer.concat(this.chunks, this.length);
      this.chunks = []; this.length = 0;
      try { receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))); }
      catch (error) { throw error instanceof ComputeError ? error : new ComputeError("output_exceeded", "Invalid calculation output"); }
      offset = newline + 1;
    }
  }
  end(): void {
    if (this.length) throw new ComputeError("output_exceeded", "Incomplete calculation output");
  }
}
