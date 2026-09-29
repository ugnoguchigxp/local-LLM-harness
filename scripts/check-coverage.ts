export type CoverageSummary = {
  functions: { found: number; hit: number };
  lines: { found: number; hit: number };
};

export type CoverageThreshold = {
  functions: number;
  lines: number;
};

export const CRITICAL_COVERAGE_THRESHOLDS: Readonly<Record<string, CoverageThreshold>> = {
  "apps/daemon/src/agent-connection-controller.ts": { functions: 97, lines: 98 },
  "apps/daemon/src/connection-token.ts": { functions: 100, lines: 100 },
  "apps/daemon/src/context-controller.ts": { functions: 86, lines: 79 },
  "apps/daemon/src/controller.ts": { functions: 92, lines: 98 },
  "apps/daemon/src/gateway.ts": { functions: 68, lines: 99 },
  "apps/daemon/src/provider-instance-manager.ts": { functions: 94, lines: 97 },
  "apps/daemon/src/runtime-release-manager.ts": { functions: 84, lines: 94 },
  "packages/client/src/index.ts": { functions: 83, lines: 93 },
  "packages/client/src/client-media.ts": { functions: 88, lines: 100 },
  "packages/core/src/allocation.ts": { functions: 100, lines: 95 },
  "packages/core/src/api-contract.ts": { functions: 100, lines: 99 },
  "packages/core/src/api-control-contract.ts": { functions: 100, lines: 99 },
  "packages/core/src/artifacts.ts": { functions: 100, lines: 90 },
  "packages/core/src/network.ts": { functions: 100, lines: 100 },
  "packages/core/src/api-operations.ts": { functions: 100, lines: 100 },
  "packages/core/src/api-openapi-paths.ts": { functions: 100, lines: 99 },
  "packages/core/src/runtime-release-contract.ts": { functions: 100, lines: 98 },
  "packages/core/src/openai-json.ts": { functions: 90, lines: 87 },
  "packages/core/src/openai-sse.ts": { functions: 89, lines: 98 },
  "packages/core/src/releases.ts": { functions: 70, lines: 67 },
} as const;

// Measured on 2026-09-29 from the current quality-maintainability working tree.
// This is a provisional baseline until the changes have an immutable merge commit.
// Keep it separate from the minimum thresholds so a baseline cannot silently fall
// back to the original, looser gate during ordinary source changes.
export const CRITICAL_COVERAGE_BASELINE: Readonly<Record<string, CoverageThreshold>> = {
  "apps/daemon/src/agent-connection-controller.ts": { functions: 97.27, lines: 98.65 },
  "apps/daemon/src/connection-token.ts": { functions: 100, lines: 100 },
  "apps/daemon/src/context-controller.ts": { functions: 89.72, lines: 94.95 },
  "apps/daemon/src/controller.ts": { functions: 96.23, lines: 99.53 },
  "apps/daemon/src/gateway.ts": { functions: 68.09, lines: 99.03 },
  "apps/daemon/src/provider-instance-manager.ts": { functions: 94.74, lines: 97.79 },
  "apps/daemon/src/runtime-release-manager.ts": { functions: 84.31, lines: 94.36 },
  "packages/client/src/index.ts": { functions: 93.33, lines: 94.36 },
  "packages/client/src/client-media.ts": { functions: 88.89, lines: 100 },
  "packages/core/src/allocation.ts": { functions: 100, lines: 95.15 },
  "packages/core/src/api-contract.ts": { functions: 100, lines: 100 },
  "packages/core/src/api-control-contract.ts": { functions: 100, lines: 100 },
  "packages/core/src/artifacts.ts": { functions: 100, lines: 90.91 },
  "packages/core/src/network.ts": { functions: 100, lines: 100 },
  "packages/core/src/api-operations.ts": { functions: 100, lines: 100 },
  "packages/core/src/api-openapi-paths.ts": { functions: 100, lines: 100 },
  "packages/core/src/runtime-release-contract.ts": { functions: 100, lines: 100 },
  "packages/core/src/openai-json.ts": { functions: 90.91, lines: 87.39 },
  "packages/core/src/openai-sse.ts": { functions: 89.66, lines: 98.68 },
  "packages/core/src/releases.ts": { functions: 70.59, lines: 67.17 },
};

export const CRITICAL_COVERAGE_GROUPS = {
  "artifact store safety and lifecycle": {
    files: [
      "packages/backends/src/artifact-store.ts",
      "packages/backends/src/artifact-store-activation.ts",
      "packages/backends/src/artifact-store-active.ts",
      "packages/backends/src/artifact-store-errors.ts",
      "packages/backends/src/artifact-store-journal.ts",
      "packages/backends/src/artifact-store-safety.ts",
      "packages/backends/src/artifact-store-snapshot.ts",
    ],
    functions: 94,
    lines: 98.8,
  },
  "artifact file download pipeline": {
    files: ["packages/backends/src/artifact-store-download.ts"],
    functions: 80,
    lines: 90,
  },
  "artifact snapshot staging pipeline": {
    files: ["packages/backends/src/artifact-store-snapshot.ts"],
    functions: 80,
    lines: 90,
  },
  "control plane admission and startup reconciliation": {
    files: [
      "apps/daemon/src/allocation-admission.ts",
      "apps/daemon/src/allocation-admission-planner.ts",
      "apps/daemon/src/allocation-waiting-promotion.ts",
      "apps/daemon/src/allocation-startup-lifecycle.ts",
      "apps/daemon/src/allocation-api-lifecycle.ts",
      "apps/daemon/src/allocation-binding-resolver.ts",
      "apps/daemon/src/allocation-request-admission.ts",
      "apps/daemon/src/allocation-lifecycle-commit.ts",
      "apps/daemon/src/allocation-preemption.ts",
      "apps/daemon/src/allocation-timers.ts",
      "apps/daemon/src/controller.ts",
      "apps/daemon/src/legacy-control-operations.ts",
      "apps/daemon/src/control-plane-startup-reconciliation.ts",
    ],
    functions: 90,
    lines: 95,
  },
  "client provider-specific protocol contracts": {
    files: ["packages/client/src/client-provider-protocols.ts"],
    functions: 50,
    lines: 95,
  },
  "client context and Personal State API": {
    files: ["packages/client/src/client-context-api.ts"],
    functions: 75,
    lines: 90,
  },
  "client allocation lifecycle API": {
    files: ["packages/client/src/client-allocation-api.ts"],
    functions: 80,
    lines: 90,
  },
  "client Agent Connection lifecycle API": {
    files: ["packages/client/src/client-agent-connections.ts"],
    functions: 80,
    lines: 95,
  },
  "daemon HTTP composition": {
    files: [
      "apps/daemon/src/app.ts",
      "apps/daemon/src/app-request-policy.ts",
      "apps/daemon/src/app-gateway-ingress.ts",
      "apps/daemon/src/app-auth.ts",
      "apps/daemon/src/app-allocation-gateway.ts",
      "apps/daemon/src/app-gateway-handler.ts",
      "apps/daemon/src/app-gateway-request.ts",
      "apps/daemon/src/app-personal-state-attempt.ts",
      "apps/daemon/src/app-http.ts",
      "apps/daemon/src/app-model-broker-gateway.ts",
      "apps/daemon/src/app-scoped-provider.ts",
      "apps/daemon/src/managed-context-gateway.ts",
      "apps/daemon/src/gateway-request-lifecycle.ts",
      "apps/daemon/src/routes/agent-profiles.ts",
      "apps/daemon/src/routes/health.ts",
      "apps/daemon/src/routes/inspection.ts",
      "apps/daemon/src/routes/managed-context.ts",
      "apps/daemon/src/routes/personal-state.ts",
      "apps/daemon/src/routes/runtime-releases.ts",
      "apps/daemon/src/service-harness-gateway.ts",
    ],
    functions: 77,
    lines: 72,
  },
  "managed context lifecycle and materialization": {
    files: [
      "apps/daemon/src/context-controller.ts",
      "apps/daemon/src/context-controller-errors.ts",
      "apps/daemon/src/context-source-registration.ts",
      "apps/daemon/src/context-runtime-readiness.ts",
      "apps/daemon/src/context-runtime-eligibility.ts",
      "apps/daemon/src/context-personal-state-bridge.ts",
      "apps/daemon/src/context-personal-state-coordinator.ts",
      "apps/daemon/src/context-request-materializer.ts",
      "apps/daemon/src/context-request-measurement.ts",
      "apps/daemon/src/context-request-finalization.ts",
      "apps/daemon/src/context-chat-request-lifecycle.ts",
      "apps/daemon/src/context-operation-commit.ts",
      "apps/daemon/src/context-view-planner.ts",
      "apps/daemon/src/context-view-commit.ts",
      "apps/daemon/src/context-view-creation-lifecycle.ts",
      "apps/daemon/src/context-projection.ts",
      "apps/daemon/src/context-view-admission.ts",
      "apps/daemon/src/context-view-lifecycle.ts",
      "apps/daemon/src/personal-state-context-invalidation.ts",
      "apps/daemon/src/personal-state-attempt-lifecycle.ts",
      "apps/daemon/src/personal-state-source-coordinator.ts",
      "apps/daemon/src/personal-state-measurement.ts",
    ],
    functions: 86,
    lines: 79,
  },
} as const;

export const CRITICAL_GROUP_BASELINE: Readonly<Record<string, CoverageThreshold>> = {
  "artifact store safety and lifecycle": { functions: 97.64, lines: 99.41 },
  "artifact file download pipeline": { functions: 80, lines: 93.79 },
  "artifact snapshot staging pipeline": { functions: 95, lines: 100 },
  "control plane admission and startup reconciliation": { functions: 96.7, lines: 98.6 },
  "client provider-specific protocol contracts": { functions: 58.33, lines: 96.18 },
  "client context and Personal State API": { functions: 94.74, lines: 97.4 },
  "client allocation lifecycle API": { functions: 100, lines: 100 },
  "client Agent Connection lifecycle API": { functions: 91.3, lines: 97.42 },
  "daemon HTTP composition": { functions: 84.25, lines: 80.99 },
  "managed context lifecycle and materialization": { functions: 91.45, lines: 94.29 },
};

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function parseLcov(input: string): Map<string, CoverageSummary> {
  const summaries = new Map<string, CoverageSummary>();
  let path: string | undefined;
  let functionsFound: number | undefined;
  let functionsHit: number | undefined;
  let linesFound: number | undefined;
  let linesHit: number | undefined;

  const finish = () => {
    if (path === undefined) return;
    if (
      functionsFound === undefined
      || functionsHit === undefined
      || linesFound === undefined
      || linesHit === undefined
    ) {
      throw new Error(`incomplete LCOV summary for ${path}`);
    }
    summaries.set(normalizePath(path), {
      functions: { found: functionsFound, hit: functionsHit },
      lines: { found: linesFound, hit: linesHit },
    });
    path = undefined;
    functionsFound = undefined;
    functionsHit = undefined;
    linesFound = undefined;
    linesHit = undefined;
  };

  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      finish();
      path = line.slice(3);
    } else if (line.startsWith("FNF:")) {
      functionsFound = parseCount(line, "FNF:");
    } else if (line.startsWith("FNH:")) {
      functionsHit = parseCount(line, "FNH:");
    } else if (line.startsWith("LF:")) {
      linesFound = parseCount(line, "LF:");
    } else if (line.startsWith("LH:")) {
      linesHit = parseCount(line, "LH:");
    } else if (line === "end_of_record") {
      finish();
    }
  }
  finish();
  return summaries;
}

function parseCount(line: string, prefix: string): number {
  const value = Number(line.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid LCOV count: ${line}`);
  }
  return value;
}

function percentage(metric: { found: number; hit: number }): number {
  return metric.found === 0 ? 100 : (metric.hit / metric.found) * 100;
}

export function checkCoverage(
  summaries: ReadonlyMap<string, CoverageSummary>,
  thresholds: Readonly<Record<string, CoverageThreshold>> = CRITICAL_COVERAGE_THRESHOLDS,
  groups: Readonly<Record<string, {
    files: readonly string[];
    functions: number;
    lines: number;
  }>> = CRITICAL_COVERAGE_GROUPS,
  baseline: Readonly<Record<string, CoverageThreshold>> = {},
  groupBaseline: Readonly<Record<string, CoverageThreshold>> = {},
): string[] {
  const failures: string[] = [];
  for (const [path, threshold] of Object.entries(thresholds)) {
    const summary = summaries.get(path);
    if (!summary) {
      failures.push(`${path}: missing from LCOV report`);
      continue;
    }
    for (const metric of ["functions", "lines"] as const) {
      const actual = percentage(summary[metric]);
      const required = Math.max(threshold[metric], baseline[path]?.[metric] ?? 0);
      if (actual + 0.005 < required) {
        failures.push(
          `${path}: ${metric} ${actual.toFixed(2)}% is below ${required.toFixed(2)}%`,
        );
      }
    }
  }
  for (const [name, group] of Object.entries(groups)) {
    const missing = group.files.filter((path) => !summaries.has(path));
    if (missing.length > 0) {
      failures.push(`${name}: missing from LCOV report: ${missing.join(", ")}`);
      continue;
    }
    for (const metric of ["functions", "lines"] as const) {
      const total = group.files.reduce((sum, path) => sum + summaries.get(path)![metric].found, 0);
      const hit = group.files.reduce((sum, path) => sum + summaries.get(path)![metric].hit, 0);
      const actual = percentage({ found: total, hit });
      const required = Math.max(group[metric], groupBaseline[name]?.[metric] ?? 0);
      if (actual + 0.005 < required) {
        failures.push(
          `${name}: ${metric} ${actual.toFixed(2)}% is below ${required.toFixed(2)}%`,
        );
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const path = process.argv[2] ?? "coverage/lcov.info";
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`coverage report does not exist: ${path}`);
    process.exit(1);
  }
  try {
    const summaries = parseLcov(await file.text());
    const failures = checkCoverage(summaries, CRITICAL_COVERAGE_THRESHOLDS, CRITICAL_COVERAGE_GROUPS, CRITICAL_COVERAGE_BASELINE, CRITICAL_GROUP_BASELINE);
    if (failures.length > 0) {
      console.error("critical coverage ratchet failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(
      `critical coverage ratchet passed (${Object.keys(CRITICAL_COVERAGE_THRESHOLDS).length} files)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
