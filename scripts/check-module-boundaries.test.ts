import { expect, test } from "bun:test";
import { checkModuleBoundaries } from "./check-module-boundaries";

test("accepts a one-way module dependency", () => {
  expect(checkModuleBoundaries({
    "apps/daemon/src/app.ts": 'import { service } from "./service";',
    "apps/daemon/src/service.ts": "export const service = 1;",
  })).toEqual([]);
});

test("rejects runtime import cycles and domain to route imports", () => {
  expect(checkModuleBoundaries({
    "apps/daemon/src/first.ts": 'import "./second";',
    "apps/daemon/src/second.ts": 'import "./first"; import "./routes/health";',
    "apps/daemon/src/routes/health.ts": "export const health = true;",
  })).toEqual([
    "apps/daemon/src/second.ts: domain module imports HTTP route apps/daemon/src/routes/health.ts",
    "runtime import cycle: apps/daemon/src/first.ts -> apps/daemon/src/second.ts -> apps/daemon/src/first.ts",
  ]);
});

test("ignores type-only imports when checking runtime cycles", () => {
  expect(checkModuleBoundaries({
    "packages/core/src/first.ts": 'import { type Second } from "./second"; export type First = Second;',
    "packages/core/src/second.ts": 'import { first } from "./first"; export type Second = typeof first;',
  })).toEqual([]);
});
