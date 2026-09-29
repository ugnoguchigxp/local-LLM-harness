import { describe, expect, test } from "bun:test";
import { checkCoverage, parseLcov } from "./check-coverage";

function record(path: string, values: { fnFound: number; fnHit: number; lineFound: number; lineHit: number }) {
  return [
    "TN:",
    `SF:${path}`,
    `FNF:${values.fnFound}`,
    `FNH:${values.fnHit}`,
    `LF:${values.lineFound}`,
    `LH:${values.lineHit}`,
    "end_of_record",
  ].join("\n");
}

describe("coverage ratchet", () => {
  test("parses summaries and accepts exact thresholds", () => {
    const summaries = parseLcov(record("./src/example.ts", {
      fnFound: 10,
      fnHit: 8,
      lineFound: 20,
      lineHit: 18,
    }));

    expect(checkCoverage(summaries, {
      "src/example.ts": { functions: 80, lines: 90 },
    }, {})).toEqual([]);
  });

  test("reports missing files and metric regressions", () => {
    const summaries = parseLcov(record("src/example.ts", {
      fnFound: 10,
      fnHit: 7,
      lineFound: 20,
      lineHit: 17,
    }));

    expect(checkCoverage(summaries, {
      "src/example.ts": { functions: 80, lines: 90 },
      "src/missing.ts": { functions: 1, lines: 1 },
    }, {})).toEqual([
      "src/example.ts: functions 70.00% is below 80.00%",
      "src/example.ts: lines 85.00% is below 90.00%",
      "src/missing.ts: missing from LCOV report",
    ]);
  });

  test("rejects a regression below the measured baseline even above the minimum", () => {
    const summaries = parseLcov(record("src/example.ts", {
      fnFound: 100, fnHit: 89, lineFound: 100, lineHit: 94,
    }));
    expect(checkCoverage(summaries, {
      "src/example.ts": { functions: 80, lines: 90 },
    }, {}, {
      "src/example.ts": { functions: 90, lines: 95 },
    })).toEqual([
      "src/example.ts: functions 89.00% is below 90.00%",
      "src/example.ts: lines 94.00% is below 95.00%",
    ]);
  });

  test("aggregates split modules into one responsibility ratchet", () => {
    const summaries = parseLcov([
      record("src/app.ts", { fnFound: 3, fnHit: 2, lineFound: 10, lineHit: 8 }),
      record("src/routes.ts", { fnFound: 1, fnHit: 1, lineFound: 10, lineHit: 10 }),
    ].join("\n"));

    expect(checkCoverage(summaries, {}, {
      composition: {
        files: ["src/app.ts", "src/routes.ts"],
        functions: 75,
        lines: 90,
      },
    })).toEqual([]);
  });

  test("rejects a group regression below its measured baseline", () => {
    const summaries = parseLcov(record("src/route.ts", {
      fnFound: 100, fnHit: 85, lineFound: 100, lineHit: 90,
    }));
    expect(checkCoverage(summaries, {}, {
      routes: { files: ["src/route.ts"], functions: 80, lines: 85 },
    }, {}, {
      routes: { functions: 86, lines: 91 },
    })).toEqual([
      "routes: functions 85.00% is below 86.00%",
      "routes: lines 90.00% is below 91.00%",
    ]);
  });

  test("rejects incomplete and malformed summaries", () => {
    expect(() => parseLcov("SF:src/example.ts\nFNF:1\nFNH:1\nend_of_record")).toThrow(
      "incomplete LCOV summary",
    );
    expect(() => parseLcov(record("src/example.ts", {
      fnFound: -1,
      fnHit: 0,
      lineFound: 1,
      lineHit: 1,
    }))).toThrow("invalid LCOV count");
  });
});
