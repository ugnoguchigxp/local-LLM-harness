import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ComputeError } from "@larm/core";

function canonical(path: string): string {
  if (!isAbsolute(path)) throw new ComputeError("unavailable", "Compute directories must be absolute", 503);
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

/** Resolve existing ancestors too: a not-yet-created state directory may sit below a symlink. */
export function assertComputeStorageIsolation(stateRoot: string, runtimeRoot: string): void {
  const state = canonical(stateRoot), runtime = canonical(runtimeRoot);
  if (state === "/" || runtime === "/" || state === runtime || state.startsWith(`${runtime}/`) || runtime.startsWith(`${state}/`)) {
    throw new ComputeError("unavailable", "Compute state and Python environment must be disjoint dedicated directories", 503);
  }
}
