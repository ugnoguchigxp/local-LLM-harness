import type { ContextTokenizerIdentity } from "@larm/backends";
import {
  deriveContextActivation,
  type ClusterState,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import type { ContextRuntimeStatus } from "./context-controller-types";

export type ContextRuntimeProbe = {
  release: string;
  checkedAt: number;
  ok: boolean;
  reason: string;
};

export class ContextRuntimeReadiness {
  private readonly probes = new Map<string, ContextRuntimeProbe>();
  private readonly epochs = new Map<string, { fingerprint: string; epoch: number }>();
  private refreshPromise?: Promise<void>;

  constructor(private readonly options: {
    enabled: boolean;
    registry: Registry;
    releases: ReadonlyMap<string, RuntimeReleaseDefinition>;
    getState: () => ClusterState;
    getActiveRelease: (runtimeId: string) => string | undefined;
    identity: (endpoint: string, signal?: AbortSignal) => Promise<ContextTokenizerIdentity>;
    isDraining: () => boolean;
    stateMaxAgeMs: number;
    now: () => number;
    onProbe: (runtime: string, release: string, ok: boolean) => void;
  }) {}

  async refresh(): Promise<void> {
    if (!this.options.enabled || this.options.isDraining()) return;
    if (this.refreshPromise) return await this.refreshPromise;
    const refresh = Promise.all(this.options.registry.runtimes.map(async (runtime) => {
      if (runtime.context?.class !== "managed-context") return;
      const snapshot = this.options.getState().runtimes.find((candidate) => candidate.id === runtime.id);
      const observedAt = snapshot ? Date.parse(snapshot.observedAt) : Number.NaN;
      if (
        (snapshot?.status !== "HOT" && snapshot?.status !== "BUSY")
        || snapshot.health?.ok !== true
        || !Number.isFinite(observedAt)
        || this.options.now() - observedAt > this.options.stateMaxAgeMs
      ) {
        this.probes.delete(runtime.id);
        return;
      }
      const releaseId = this.options.getActiveRelease(runtime.id);
      const certification = releaseId
        ? this.options.releases.get(releaseId)?.contextCertification
        : undefined;
      if (!releaseId || !certification) {
        this.probes.delete(runtime.id);
        return;
      }
      const existing = this.probes.get(runtime.id);
      if (
        existing?.release === releaseId
        && existing.ok
        && this.options.now() - existing.checkedAt <= this.options.stateMaxAgeMs
      ) return;

      let ok = false;
      let reason = "context_probe_failed";
      try {
        const identity = await this.options.identity(
          runtime.deployment.endpoint,
          AbortSignal.timeout(Math.min(this.options.stateMaxAgeMs, 15_000)),
        );
        ok = identity.chatTemplateDigest === certification.chatTemplateDigest
          && identity.tokenizerDigest === certification.tokenizerDigest
          && identity.contextLimitTokens === certification.contextLimitTokens
          && (
            certification.engineBuild === identity.engineBuild
            || certification.engineBuild.startsWith(`${identity.engineBuild}-bin-`)
          );
        reason = ok ? "context_probe_ok" : "context_probe_identity_mismatch";
      } catch {
        reason = "context_probe_unavailable";
      }
      this.setProbe(runtime.id, releaseId, ok, reason);
      this.options.onProbe(runtime.id, releaseId, ok);
    })).then(() => undefined);
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = undefined;
    }
  }

  getProbe(runtimeId: string): ContextRuntimeProbe | undefined {
    return this.probes.get(runtimeId);
  }

  activation(runtimeId: string): ContextRuntimeStatus {
    const runtime = this.options.registry.runtimes.find((candidate) => candidate.id === runtimeId);
    const activeRelease = this.options.getActiveRelease(runtimeId);
    const release = activeRelease ? this.options.releases.get(activeRelease) : undefined;
    const snapshot = this.options.getState().runtimes.find((candidate) => candidate.id === runtimeId);
    const probe = this.probes.get(runtimeId);
    const observedAt = snapshot ? Date.parse(snapshot.observedAt) : Number.NaN;
    const derived = deriveContextActivation({
      enabled: this.options.enabled,
      policy: runtime?.context,
      reasoningCapable: runtime?.capability.includes("llm.reasoning") ?? false,
      certification: release?.contextCertification,
      activeRelease,
      runtimeStatus: snapshot?.status,
      observationFresh: Number.isFinite(observedAt)
        && this.options.now() - observedAt <= this.options.stateMaxAgeMs,
      probeOk: snapshot?.health?.ok === true
        && probe?.ok === true
        && probe.release === activeRelease
        && this.options.now() - probe.checkedAt <= this.options.stateMaxAgeMs,
      draining: this.options.isDraining(),
    });
    const active = derived.state === "ACTIVE" || derived.state === "BUSY";
    const fingerprint = active
      ? `active:${activeRelease ?? "none"}`
      : `inactive:${derived.state}:${activeRelease ?? "none"}`;
    const epoch = this.advanceEpoch(runtimeId, fingerprint);
    return {
      runtime: runtimeId,
      ...(activeRelease ? { release: activeRelease } : {}),
      ...derived,
      modes: derived.modes,
      ...(derived.reason === "context_probe_pending" && probe?.reason
        ? { reason: probe.reason }
        : {}),
      leaseEpoch: epoch,
    };
  }

  setProbe(runtimeId: string, release: string, ok: boolean, reason: string): void {
    this.probes.set(runtimeId, {
      release,
      checkedAt: this.options.now(),
      ok,
      reason,
    });
  }

  advanceEpoch(runtimeId: string, fingerprint: string): number {
    const previous = this.epochs.get(runtimeId);
    const epoch = previous?.fingerprint === fingerprint ? previous.epoch : (previous?.epoch ?? 0) + 1;
    this.epochs.set(runtimeId, { fingerprint, epoch });
    return epoch;
  }

  beginDrain(): void {
    for (const [runtimeId, current] of this.epochs) {
      this.epochs.set(runtimeId, {
        fingerprint: `draining:${current.fingerprint}`,
        epoch: current.epoch + 1,
      });
    }
  }
}
