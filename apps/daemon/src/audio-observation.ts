/** Reads at most 64 KiB of a WAV header. Never retains audio payload. */
export class AudioObservation {
  private prefix = new Uint8Array(0);
  private received = 0;
  private dataOffset?: number;
  private dataSize?: number;
  private byteRate?: number;
  private stopped = false;

  push(bytes: Uint8Array): boolean {
    this.received += bytes.byteLength;
    if (!this.stopped) {
      const length = Math.min(65536, this.prefix.length + bytes.length);
      const next = new Uint8Array(length);
      next.set(this.prefix);
      next.set(bytes.subarray(0, length - this.prefix.length), this.prefix.length);
      this.prefix = next;
      this.inspect();
      if (this.prefix.length === 65536 || this.dataOffset !== undefined) {
        this.stopped = true;
        this.prefix = new Uint8Array(0);
      }
    }
    return this.dataOffset !== undefined && this.received > this.dataOffset;
  }

  durationSeconds(): number | undefined {
    if (!this.byteRate || !this.dataSize || this.dataOffset === undefined
      || this.received < this.dataOffset + this.dataSize || this.dataSize === 0xffffffff) return undefined;
    return this.dataSize / this.byteRate;
  }

  private inspect(): void {
    const bytes = this.prefix;
    const ascii = (offset: number, n: number) => String.fromCharCode(...bytes.subarray(offset, offset + n));
    if (bytes.length < 12) return;
    if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") { this.stopped = true; this.prefix = new Uint8Array(0); return; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const size = view.getUint32(offset + 4, true);
      if (ascii(offset, 4) === "fmt " && size >= 16 && offset + 24 <= bytes.length) this.byteRate = view.getUint32(offset + 16, true);
      if (ascii(offset, 4) === "data") { this.dataOffset = offset + 8; this.dataSize = size; return; }
      offset += 8 + size + size % 2;
    }
  }
}
