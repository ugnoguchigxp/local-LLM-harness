import { createHash } from "node:crypto";
import {
  loadArtifactManifest,
  loadRegistry,
  loadRuntimeReleaseCatalog,
  type ArtifactDefinition,
  type CatalogReloadPlan,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import {
  createRuntimeBackend,
  type RuntimeBackend,
  SwappableRuntimeBackend,
} from "@larm/backends";
import type { ArtifactManager } from "./artifact-manager";
import type { ControlEvent, ControlPlane } from "./controller";
import type { ExecutionGate } from "./execution-gate";
import type { Observer } from "./observer";
import type { RuntimeReleaseManager } from "./runtime-release-manager";
import {
  type MutationCoordinator,
  MutationCoordinatorError,
  type MutationLease,
} from "./mutation-coordinator";

export type CatalogGeneration = {
  revision: string;
  registry: Registry;
  artifacts: ArtifactDefinition[];
  releases: RuntimeReleaseDefinition[];
};

export type CatalogPaths = {
  configDir: string;
  artifactManifestPath: string;
  releaseCatalogPath: string;
};

export class CatalogManagerError extends Error {
  constructor(
    readonly code:
      | "catalog_reload_in_progress"
      | "catalog_reload_blocked"
      | "catalog_revision_conflict"
      | "catalog_candidate_changed"
      | "catalog_reload_failed",
    message: string,
    readonly blockers: string[] = [],
  ) {
    super(message);
    this.name = "CatalogManagerError";
  }
}

export function computeCatalogGenerationRevision(input: {
  registry: Registry;
  artifacts: ArtifactDefinition[];
  releases: RuntimeReleaseDefinition[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    nodes: input.registry.nodes,
    runtimes: input.registry.runtimes,
    profiles: input.registry.profiles,
    routes: input.registry.routes,
    artifacts: input.artifacts,
    releases: input.releases,
  })).digest("hex");
}

export function loadCatalogGeneration(paths: CatalogPaths): CatalogGeneration {
  const registry = loadRegistry(paths.configDir);
  const artifacts = loadArtifactManifest(paths.artifactManifestPath);
  const releases = loadRuntimeReleaseCatalog(paths.releaseCatalogPath, registry, artifacts);
  return {
    registry,
    artifacts,
    releases,
    revision: computeCatalogGenerationRevision({ registry, artifacts, releases }),
  };
}

function residentContract(registry: Registry): string {
  return JSON.stringify({
    runtimes: registry.runtimes.filter((runtime) => runtime.policy.class === "resident"),
    defaultRoutes: registry.routes.filter((route) => !route.explicitOnly),
  });
}

export class CatalogManager {
  private reloading = false;

  constructor(
    private current: CatalogGeneration,
    private readonly paths: CatalogPaths,
    private readonly control: ControlPlane,
    private readonly observer: Observer,
    private readonly backend: SwappableRuntimeBackend,
    private readonly artifactManager: ArtifactManager,
    private readonly runtimeReleaseManager: RuntimeReleaseManager,
    private readonly executionGate: ExecutionGate,
    private readonly options: {
      load?: (paths: CatalogPaths) => CatalogGeneration;
      createBackend?: (generation: CatalogGeneration) => RuntimeBackend;
      onEvent?: (event: ControlEvent) => void;
      mutationCoordinator?: MutationCoordinator;
    } = {},
  ) {}

  get revision(): string {
    return this.current.revision;
  }

  get registry(): Registry {
    return this.current.registry;
  }

  get generation(): CatalogGeneration {
    return this.current;
  }

  get isReloading(): boolean {
    return this.reloading;
  }

  plan(): CatalogReloadPlan {
    const candidate = this.loadCandidate();
    return this.planCandidate(candidate);
  }

  async reload(
    expectedCurrentRevision: string,
    candidateRevision: string,
  ): Promise<CatalogReloadPlan> {
    if (this.reloading) {
      throw new CatalogManagerError(
        "catalog_reload_in_progress",
        "another catalog reload is already running",
      );
    }
    let mutationLease: MutationLease | undefined;
    try {
      mutationLease = this.options.mutationCoordinator?.reserve("catalog-reload");
    } catch (error) {
      if (error instanceof MutationCoordinatorError) {
        throw new CatalogManagerError(
          "catalog_reload_blocked",
          error.message,
          [error.activeKind ? `mutation_in_progress:${error.activeKind}` : error.code],
        );
      }
      throw error;
    }
    try {
      if (expectedCurrentRevision !== this.current.revision) {
        throw new CatalogManagerError(
          "catalog_revision_conflict",
          `active catalog is ${this.current.revision}, not ${expectedCurrentRevision}`,
        );
      }
      const candidate = this.loadCandidate();
      if (candidate.revision !== candidateRevision) {
        throw new CatalogManagerError(
          "catalog_candidate_changed",
          `candidate catalog is ${candidate.revision}, not ${candidateRevision}`,
        );
      }
      const plan = this.planCandidate(candidate);
      if (!plan.allowed) {
        throw new CatalogManagerError(
          "catalog_reload_blocked",
          `catalog reload is blocked: ${plan.blockers.join(", ")}`,
          plan.blockers,
        );
      }
      if (!plan.changed) return plan;

      const reservation = this.control.beginCatalogReload();
      if (!reservation.ok) {
        throw new CatalogManagerError(
          "catalog_reload_blocked",
          `catalog reload is blocked: ${reservation.blockers.join(", ")}`,
          reservation.blockers,
        );
      }
      this.reloading = true;
      const previous = this.current;
      let previousBackend: RuntimeBackend | undefined;
      let releasesReplaced = false;
      let artifactsReplaced = false;
      try {
        const nextBackend = (this.options.createBackend ?? ((generation) =>
          createRuntimeBackend(generation.registry.runtimes)))(candidate);
        previousBackend = this.backend.replace(nextBackend);
        await this.runtimeReleaseManager.replaceCatalog(candidate.releases);
        releasesReplaced = true;
        this.artifactManager.replaceCatalog(
          candidate.artifacts,
          candidate.registry,
          candidate.releases.map((release) => ({
            runtimeId: release.runtime,
            artifactIds: release.artifacts,
          })),
        );
        artifactsReplaced = true;
        await this.observer.replaceRegistry(candidate.registry);
        this.control.replaceRegistry(candidate.registry);
        this.current = candidate;
      } catch (error) {
        if (previousBackend) {
          this.backend.replace(previousBackend);
        }
        try {
          if (artifactsReplaced) {
            this.artifactManager.replaceCatalog(
              previous.artifacts,
              previous.registry,
              previous.releases.map((release) => ({
                runtimeId: release.runtime,
                artifactIds: release.artifacts,
              })),
            );
          }
          if (releasesReplaced) {
            await this.runtimeReleaseManager.replaceCatalog(previous.releases);
          }
          await this.observer.replaceRegistry(previous.registry);
          this.control.replaceRegistry(previous.registry);
        } catch (rollbackError) {
          throw new CatalogManagerError(
            "catalog_reload_failed",
            `${this.message(error)}; rollback failed: ${this.message(rollbackError)}`,
          );
        }
        throw new CatalogManagerError("catalog_reload_failed", this.message(error));
      } finally {
        this.reloading = false;
        reservation.release();
      }
      try {
        this.options.onEvent?.({
          name: "catalog_reload",
          labels: { result: "succeeded" },
        });
      } catch (error) {
        console.error(`catalog reload event callback failed: ${this.message(error)}`);
      }
      return {
        ...plan,
        currentRevision: candidate.revision,
        candidateRevision: candidate.revision,
        changed: false,
        allowed: true,
        blockers: [],
      };
    } finally {
      mutationLease?.release();
    }
  }

  private planCandidate(candidate: CatalogGeneration): CatalogReloadPlan {
    const blockers = [
      ...this.control.catalogReloadBlockers(),
      ...this.runtimeReleaseManager.catalogReplacementBlockers(candidate.releases),
    ];
    const execution = this.executionGate.totals();
    if (execution.active > 0 || execution.queued > 0) {
      blockers.push("gateway_requests_active");
    }
    if (this.artifactManager.hasActiveOperations()) {
      blockers.push("artifact_operations");
    }
    if (
      candidate.revision !== this.current.revision
      && residentContract(candidate.registry) !== residentContract(this.current.registry)
    ) {
      blockers.push("resident_change_requires_attended_restart");
    }
    return {
      currentRevision: this.current.revision,
      candidateRevision: candidate.revision,
      changed: candidate.revision !== this.current.revision,
      allowed: blockers.length === 0,
      blockers: [...new Set(blockers)],
      summary: {
        nodes: candidate.registry.nodes.length,
        runtimes: candidate.registry.runtimes.length,
        routes: candidate.registry.routes.length,
        artifacts: candidate.artifacts.length,
        releases: candidate.releases.length,
      },
    };
  }

  private loadCandidate(): CatalogGeneration {
    try {
      return (this.options.load ?? loadCatalogGeneration)(this.paths);
    } catch (error) {
      if (error instanceof CatalogManagerError) throw error;
      throw new CatalogManagerError(
        "catalog_reload_failed",
        `candidate catalog is invalid: ${this.message(error)}`,
      );
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
