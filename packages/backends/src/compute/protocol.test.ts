import { expect, test } from "bun:test";
import { ComputeJsonLines } from "./protocol";

test("compute protocol handles fragmented UTF-8 and multiple individually bounded frames", () => {
  const reader = new ComputeJsonLines({ frame: 10, total: 100 });
  const values: unknown[] = [];
  const data = Buffer.from('"あ"\n{"a":1}\n');
  reader.push(data.subarray(0, 2), value => values.push(value));
  reader.push(data.subarray(2), value => values.push(value));
  reader.end(); expect(values).toEqual(["あ", { a: 1 }]);
});

test("compute protocol bounds total/line bytes and rejects invalid or incomplete data", () => {
  expect(() => new ComputeJsonLines({ frame: 3, total: 20 }).push(Buffer.from('"long"\n'), () => {})).toThrow("output_exceeded");
  expect(() => new ComputeJsonLines({ frame: 20, total: 3 }).push(Buffer.from('1\n2\n'), () => {})).toThrow("output_exceeded");
  expect(() => new ComputeJsonLines().push(Buffer.from([34, 255, 34, 10]), () => {})).toThrow("Invalid calculation output");
  const incomplete = new ComputeJsonLines(); incomplete.push(Buffer.from("{}"), () => {});
  expect(() => incomplete.end()).toThrow("Incomplete");
});

test("compute protocol receives a large artifact frame in small chunks", () => {
  const reader = new ComputeJsonLines();
  const data = Buffer.from(JSON.stringify({ kind: "artifact", data: "x".repeat(7 * 1024 * 1024) }) + "\n");
  let frames = 0;
  for (let offset = 0; offset < data.length; offset += 4096) reader.push(data.subarray(offset, offset + 4096), () => { frames++; });
  reader.end(); expect(frames).toBe(1);
});
