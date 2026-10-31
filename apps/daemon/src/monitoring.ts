import {
  MONITORING_VERSION, MonitoringEventStore, ageMonitoringView, monitoringSample as sample, monitoringSnapshotSchema, monitoringIdSchema, primaryNode,
  type MonitoringSnapshot, type MonitoringRuntime, type MonitoringEvent, type MonitoringCoverage, type Registry,
} from "@larm/core";
import type { LinuxMonitoringSampler, KernelMonitoringReader } from "@larm/backends";
import type { ControlEvent, ControlPlane } from "./controller";
import type { Observer } from "./observer";
import type { ExecutionGate } from "./execution-gate";
import type { RequestTracker } from "./metrics";
import type { ModelBroker } from "./model-broker";
import type { GatewayReadiness } from "./gateway-lifecycle";

const REASONS = new Set(["queue_full", "queue_timeout", "request_cancelled", "client_cancelled", "attempt_cancelled", "draining", "runtime_quarantined", "exclusive_execution", "revision_conflict", "foreground_protected", "foreground_preempted", "foreground_idle_timeout", "resource_exhausted", "allocation_capacity", "stale_state", "startup_timeout", "start_failed", "stop_failed", "access_denied", "binding_invalidated", "timeout", "upstream_timeout", "upstream_error", "stream_error", "gate_error", "generation_timeout", "generation_failed", "job_persistence_failed", "media_variant_busy", "worker_stop_failed"]);
const reason = (value: string | undefined, fallback = "unclassified") => value && REASONS.has(value) ? value : fallback;
type Work = { id: string; runtime: string; forwarded: boolean; firstBody?: number; decodeRate?: number; at: number };
export type MonitoringBindings = {
  observer: Pick<Observer, "getState" | "monitoringSnapshot">;
  gate: Pick<ExecutionGate, "monitoringSnapshot">;
  control: Pick<ControlPlane, "getProviderInstances" | "isDraining">;
  tracker?: Pick<RequestTracker, "count">;
  broker?: Pick<ModelBroker, "monitoringPreparation">;
  readiness?: () => GatewayReadiness;
  music?: boolean; image?: boolean;
};

/** Observation consumer only: no leases, ensure, resolve or backend-control references. */
export class MonitoringService {
  readonly events: MonitoringEventStore;
  private bindings?: MonitoringBindings;
  private saved?: MonitoringSnapshot;
  private host?: Awaited<ReturnType<LinuxMonitoringSampler["observe"]>>;
  private hostAttempt?: string;
  private kernelCoverage: MonitoringCoverage = { id: "kernel_events", status: "unavailable", since: null, through: null, reasonCode: "not_collected" };
  private kernelFlight?: Promise<void>;
  private sensorFlight?: Promise<void>;
  private readonly works = new Map<string, Work>();
  private readonly terminal = new Map<string, number>();
  private readonly mediaWorks = new Map<string, { id: string; state: string; at: number }>();
  private readonly lastRate = new Map<string, MonitoringRuntime["lastDecodeTokensPerSecond"]>();
  private readonly lastBody = new Map<string, MonitoringRuntime["lastFirstResponseMs"]>();
  private readonly previousStates = new Map<string, string>();
  private readonly previousLoads = new Map<string, string>();
  private readonly instrumentedLoads = new Set<string>();
  private readonly captured = new WeakSet<ControlEvent>();
  private previousOom?: { value: bigint; at: string; mono: number; epoch: string };
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private readonly startedMono: number;
  readonly startedAt: string;
  constructor(readonly registry: Registry, readonly bootEpoch: string, private readonly options: {
    now?: () => number; monotonic?: () => number; startedAt?: string; startedMonotonic?: number;
    sampler?: Pick<LinuxMonitoringSampler, "observe">; kernel?: Pick<KernelMonitoringReader, "read">;
  } = {}) {
    this.startedMono = options.startedMonotonic ?? this.mono(); this.startedAt = options.startedAt ?? this.iso();
    this.events = new MonitoringEventStore(bootEpoch, options);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private mono(): number { return this.options.monotonic?.() ?? performance.now(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  bind(bindings: MonitoringBindings): void { this.bindings = bindings; this.publish(); }
  start(intervalMs = 2000): () => void {
    if (!this.timer) {
      void this.collect();
      this.timer = setInterval(() => { this.publish(); this.events.prune(); void this.collect(); }, intervalMs);
      this.timer.unref();
    }
    return () => { if (this.timer) clearInterval(this.timer); this.timer = undefined; };
  }
  async collect(): Promise<void> {
    if (this.options.sampler && !this.sensorFlight) {
      this.sensorFlight = this.options.sampler.observe().then(host => {
        this.host = host; this.hostAttempt = undefined;
        const oom = host.node.memory.oomKills;
        if (oom.status === "ok" && oom.value !== undefined && oom.observedAt && oom.counterEpoch) {
          const current = { value: BigInt(oom.value), at: oom.observedAt, mono: this.mono(), epoch: oom.counterEpoch }, old = this.previousOom;
          if (old && old.epoch === current.epoch && current.value > old.value && current.mono > old.mono && current.at > old.at) this.emit("host.oom_counter_changed", "node", host.node.nodeId, "oom_counter_increased", { countDelta: String(current.value - old.value), observationInterval: { startAt: old.at, endAt: current.at, durationMs: current.mono - old.mono } });
          this.previousOom = current;
        }
      }).catch(() => { this.hostAttempt = this.iso(); }).finally(() => { this.sensorFlight = undefined; this.publish(); });
    }
    if (this.options.kernel && !this.kernelFlight) {
      this.kernelFlight = this.options.kernel.read().then(({ facts, coverage }) => {
        this.kernelCoverage = coverage;
        const nodeId = primaryNode(this.registry.nodes, this.registry.runtimes).id;
        for (const f of facts) {
          const gpu = this.host?.node.gpus.value?.find(g => g.identity.value?.busId === f.busId);
          this.emit(f.kind, gpu ? "gpu" : "node", gpu?.id ?? nodeId, f.reasonCode, { occurredAt: f.occurredAt, source: "kernel-journal", sourceEventId: f.sourceEventId });
        }
      }).catch(() => { this.kernelCoverage = { ...this.kernelCoverage, status: "error", since: null, reasonCode: "journal_read_failed" }; }).finally(() => { this.kernelFlight = undefined; this.publish(); });
    }
    await Promise.all([this.sensorFlight, this.kernelFlight]);
  }
  private emit(kind: MonitoringEvent["kind"], type: MonitoringEvent["target"]["type"], id: string, reasonCode: string, extra: Partial<MonitoringEvent> = {}): void {
    if (!monitoringIdSchema.safeParse(id).success) return;
    try { this.events.append({ kind, target: { type, id, nodeId: this.registry.runtimes.find(r => r.id === id)?.node ?? (type === "daemon" ? null : primaryNode(this.registry.nodes, this.registry.runtimes).id) },
      occurredAt: this.iso(), workId: null, reasonCode, outcome: "observed", fromState: null, toState: null, countDelta: null, observationInterval: null, source: "daemon-state", sourceEventId: null, ...extra }); }
    catch { this.events.noteLoss(); }
  }
  /** Only known event types and fixed fields are projected. Arbitrary labels/messages are never copied. */
  capture = (event: ControlEvent): void => {
    if (this.captured.has(event)) return;
    this.captured.add(event);
    try { this.captureEvent(event); } catch { /* Fail open for the control/data plane. */ }
  };
  private captureEvent(event: ControlEvent): void {
    const labels = event.labels ?? {}, runtime = labels.runtime;
    if (event.name === "daemon_starting") { this.emit("daemon.started", "daemon", this.bootEpoch, "daemon_starting"); return; }
    if (event.name === "gateway_readiness_transition") {
      const states = new Set(["starting", "verifying", "ready", "draining", "failed"]);
      if (states.has(labels.to!)) this.emit("daemon.readiness_changed", "daemon", this.bootEpoch, "readiness_transition", { fromState: states.has(labels.from!) ? labels.from! : null, toState: labels.to! }); return;
    }
    if (event.name === "monitoring_control_terminal" && ["succeeded", "failed", "cancelled", "timed_out"].includes(labels.status!)) {
      this.emit("control.terminal", "daemon", this.bootEpoch, reason(labels.reason, labels.status === "cancelled" ? "operation_cancelled" : "operation_completed"),
        { outcome: labels.status as "succeeded" | "failed" | "cancelled" | "timed_out", workId: `work-${crypto.randomUUID()}`, ...(labels.occurredAt && /^\d{4}-\d\d-\d\dT/.test(labels.occurredAt) ? { occurredAt: labels.occurredAt } : {}) }); return;
    }
    if (event.name === "allocation_rejected") { this.emit("control.terminal", "daemon", this.bootEpoch, reason(labels.reason), { outcome: "rejected" }); return; }
    if (event.name === "monitoring_request_rejected") {
      this.emit("request.rejected", "daemon", this.bootEpoch, reason(labels.reason), { outcome: "rejected", workId: `work-${crypto.randomUUID()}` }); return;
    }
    if (!runtime || !this.registry.runtimes.some(r => r.id === runtime)) return;
    if (event.name === "runtime_model_load") {
      this.instrumentedLoads.add(runtime);
      if (["loading", "loaded", "failed"].includes(labels.state!)) this.emit(labels.state === "loading" ? "model.load_started" : labels.state === "loaded" ? "model.load_completed" : "model.load_failed", "runtime", runtime, reason(labels.reason, labels.state === "failed" ? "start_failed" : "load_observed"), { outcome: labels.state === "failed" ? "failed" : "observed" }); return;
    }
    const request = labels.request;
    if (!request) return;
    const key = `${runtime}\0${request}`;
    if (this.terminal.has(key)) return;
    if (event.name === "gateway_request_started") {
      if (!this.works.has(key)) {
        const work: Work = { id: `work-${crypto.randomUUID()}`, runtime, forwarded: false, at: this.mono() };
        this.works.set(key, work); this.emit("request.started", "runtime", runtime, "accepted", { workId: work.id, outcome: null });
      }
    } else {
      const work = this.works.get(key); if (!work) return;
      if (event.name === "gateway_request_queued") this.emit("request.queued", "runtime", runtime, "execution_queued", { workId: work.id, outcome: null });
      if (event.name === "gateway_request_forwarded") { work.forwarded = true; this.emit("request.forwarded", "runtime", runtime, "forwarded", { workId: work.id, outcome: null }); }
      if (event.name === "gateway_first_body_ms" && Number.isFinite(event.value) && event.value! >= 0) work.firstBody ??= event.value;
      if (event.name === "gateway_decode_rate" && Number.isFinite(event.value) && event.value! >= 0) work.decodeRate = event.value;
      if (event.name === "gateway_request_completed") {
        const raw = labels.outcome ?? "unclassified";
        const outcome = raw.includes("cancel") || raw === "binding_invalidated" ? "cancelled" : raw.includes("timeout") ? "timed_out" : /^http_2\d\d$/.test(raw) ? "succeeded" : ["queue_full", "exclusive_execution", "draining", "runtime_quarantined", "foreground_protected"].includes(raw) ? "rejected" : "failed";
        this.emit(outcome === "rejected" ? "request.rejected" : "request.terminal", "runtime", runtime, /^http_[1-5]\d\d$/.test(raw) ? raw : reason(raw), { workId: work.id, outcome });
        if (outcome === "succeeded") {
          if (work.firstBody !== undefined) this.lastBody.set(runtime, sample("milliseconds", "gateway-terminal", this.iso(), work.firstBody, { maxAgeMs: 600_000 }));
          if (work.decodeRate !== undefined) this.lastRate.set(runtime, sample("decodeRate", "gateway-terminal", this.iso(), work.decodeRate, { maxAgeMs: 600_000 }));
          else this.lastRate.set(runtime, sample("decodeRate", "gateway-terminal", this.iso(), undefined, { status: "unsupported", reason: "engine_statistics_absent", maxAgeMs: 600_000 }));
        }
        this.works.delete(key); this.terminal.set(key, this.mono());
      }
    }
  }
  media(kind: "music" | "image", workId: string, state: string, code?: string): void {
    if (!["queued", "started", "starting", "loading", "generating", "saving", "stopping", "completed", "failed", "cancelled"].includes(state)) return;
    const key = `${kind}\0${workId}`, previous = this.mediaWorks.get(key);
    if (previous && (["completed", "failed", "cancelled"].includes(previous.state) || previous.state === state)) return;
    const work = previous ?? { id: `work-${crypto.randomUUID()}`, state, at: this.mono() };
    work.state = state; work.at = this.mono(); this.mediaWorks.set(key, work);
    const terminal = ["completed", "failed", "cancelled"].includes(state);
    const outcome = state === "completed" ? "succeeded" : state === "cancelled" ? "cancelled" : state === "failed" ? (code === "generation_timeout" || code === "queue_timeout" ? "timed_out" : "failed") : null;
    this.emit(terminal ? "request.terminal" : state === "queued" ? "request.queued" : "request.started", "node", primaryNode(this.registry.nodes, this.registry.runtimes).id, reason(code, `${kind}_${state}`), { workId: work.id, outcome });
  }
  private coverage(): MonitoringCoverage[] {
    const at = this.saved?.generatedAt ?? this.iso();
    return [
      ...(["larm_gateway", "control_operations"] as const).map(id => ({ id, status: "available" as const, since: this.startedAt, through: at, reasonCode: null })),
      ...(["music_jobs", "image_jobs"] as const).map((id, index) => ({ id, status: this.bindings && (index ? this.bindings.image : this.bindings.music) ? "available" as const : "unsupported" as const, since: this.startedAt, through: at, reasonCode: this.bindings && (index ? this.bindings.image : this.bindings.music) ? null : "provider_not_configured" })),
      { ...this.kernelCoverage, ...(this.kernelCoverage.through && this.now() - Date.parse(this.kernelCoverage.through) > 10_000 && this.kernelCoverage.status === "available" ? { status: "stale" as const } : {}) },
      ...(["provider_internal_queue", "direct_provider_requests"] as const).map(id => ({ id, status: "unsupported" as const, since: null, through: null, reasonCode: "outside_larm_observation" })),
    ];
  }
  publish(): void {
    const b = this.bindings; if (!b) return;
    try {
      const at = this.iso(), state = b.observer.getState(), observed = b.observer.monitoringSnapshot(), preparation = b.broker?.monitoringPreparation();
      const runtimes: MonitoringRuntime[] = this.registry.runtimes.map(runtime => {
        const saved = state.runtimes.find(r => r.id === runtime.id), probe = observed.get(runtime.id), observedAt = probe?.observedAt ?? saved?.observedAt ?? at;
        const failure = !saved || probe?.failed;
        const status = sample("runtimeStatus", "observer", observedAt, failure ? undefined : saved.status, failure ? { status: "error", reason: "runtime_observation_failed" } : {});
        const healthOk = sample("boolean", "observer", observedAt, failure ? undefined : saved.health?.ok, failure ? { status: "error", reason: "runtime_observation_failed" } : {});
        const load = sample("modelLoadState", "observer", observedAt, failure ? undefined : probe?.modelLoadState, failure ? { status: "error", reason: "runtime_observation_failed" } : probe?.modelLoadState ? {} : { status: "unsupported", reason: "model_load_signal_absent" });
        if (status.value && this.previousStates.get(runtime.id) !== status.value) {
          this.emit("runtime.state_changed", "runtime", runtime.id, "runtime_observed", { fromState: this.previousStates.get(runtime.id) ?? null, toState: status.value, occurredAt: observedAt, source: "observer" }); this.previousStates.set(runtime.id, status.value);
        }
        if (load.value && this.previousLoads.get(runtime.id) !== load.value) {
          if (this.previousLoads.has(runtime.id) && load.value !== "unloaded" && !this.instrumentedLoads.has(runtime.id)) this.emit(load.value === "loading" ? "model.load_started" : load.value === "loaded" ? "model.load_completed" : "model.load_failed", "runtime", runtime.id, "model_observed", { occurredAt: observedAt, source: "observer" });
          this.previousLoads.set(runtime.id, load.value);
        }
        const works = [...this.works.values()].filter(w => w.runtime === runtime.id), gate = b.gate.monitoringSnapshot(runtime.id);
        const preparing = preparation?.get(runtime.id) ?? 0;
        return { runtimeId: runtime.id, nodeId: runtime.node, backend: runtime.backend,
          declaredModelIds: [...new Set([...(runtime.artifacts ?? []), ...(runtime.backend === "llama-swap" ? [runtime.deployment.modelId] : [])])],
          status, healthOk, modelLoadState: load, gpuIds: sample("identifiers", "daemon-state", at, undefined, { status: "unsupported", reason: "runtime_device_mapping_absent" }),
          inFlightRequests: sample("count", "daemon-state", at, works.length + preparing), preparingRequests: sample("count", "daemon-state", at, preparing),
          forwardedRequests: sample("count", "daemon-state", at, works.filter(w => w.forwarded).length),
          gateOccupiedSlots: sample("count", "execution-gate", at, gate.active), queuedRequests: sample("count", "execution-gate", at, gate.queued),
          oldestQueueWaitMs: sample("milliseconds", "execution-gate", at, gate.oldestQueueWaitMs ?? undefined, gate.oldestQueueWaitMs === null ? { status: "unavailable", reason: "no_waiters" } : {}),
          lastDecodeTokensPerSecond: this.lastRate.get(runtime.id) ?? sample("decodeRate", "gateway-terminal", at, undefined, { status: "unavailable", reason: "no_completed_sample", maxAgeMs: 600_000 }),
          lastFirstResponseMs: this.lastBody.get(runtime.id) ?? sample("milliseconds", "gateway-terminal", at, undefined, { status: "unavailable", reason: "no_completed_sample", maxAgeMs: 600_000 }) };
      });
      const instances = b.control.getProviderInstances().map(({ instance: i, refs, warmRefs, idleDeadline }) => ({
        instanceId: i.id, runtimeId: i.runtimeId, nodeId: i.node, generation: i.generation, revision: i.revision, createdAt: i.createdAt, reportedStatus: i.status,
        allocationRefs: refs.allocation, requestRefs: refs.request, mutationRefs: refs.mutation, warmRefs, idleDeadline: idleDeadline ?? null,
      }));
      const nodes = this.host ? [structuredClone(this.host.node)] : this.emptyNodes();
      if (this.hostAttempt) for (const node of nodes) {
        const mark = (o: unknown) => { if (!o || typeof o !== "object") return; const v = o as Record<string, unknown>; if (v.status === "ok" && v.observedAt) { v.status = "stale"; v.lastAttempt = { at: this.hostAttempt, status: "error", reasonCode: "host_collection_failed" }; } for (const child of Object.values(v)) mark(child); }; mark(node);
      }
      this.saved = monitoringSnapshotSchema.parse({ contractVersion: MONITORING_VERSION, generatedAt: at, snapshotId: `snapshot-${++this.generation}`, bootEpoch: this.bootEpoch,
        core: { startedAt: sample("timestamp", "daemon-state", at, this.startedAt), uptimeMs: sample("milliseconds", "daemon-state", at, Math.max(0, this.mono() - this.startedMono)),
          readiness: sample("readiness", "daemon-state", at, b.readiness?.().state, b.readiness ? {} : { status: "unavailable", reason: "readiness_unavailable" }), draining: sample("boolean", "daemon-state", at, b.control.isDraining()),
          activeWorkloads: sample("count", "daemon-state", at, (b.tracker?.count() ?? this.works.size) + [...(preparation?.values() ?? [])].reduce((a, n) => a + n, 0)), runtimes, providerInstances: sample("instances", "daemon-state", at, instances) },
        nodes, modelStorage: this.host?.modelStorage ?? sample("filesystems", "statfs", at, undefined, { status: "unavailable", reason: "not_collected", maxAgeMs: 120_000 }),
        coverage: this.coverage(), eventStream: this.events.metadata() });
      for (const [id, when] of this.terminal) if (this.mono() - when > 600_000 || this.terminal.size > 100_000) this.terminal.delete(id);
      for (const [id, work] of this.mediaWorks) if ((["completed", "failed", "cancelled"].includes(work.state) && this.mono() - work.at > 600_000) || this.mediaWorks.size > 100_000) this.mediaWorks.delete(id);
    } catch { /* Keep the last valid view with its original sample timestamps. */ }
  }
  snapshot(): MonitoringSnapshot | undefined {
    if (!this.saved) return;
    const view = ageMonitoringView(this.saved, this.now());
    view.generatedAt = this.iso(); view.eventStream = this.events.metadata();
    // Coverage is aged without advancing its original through timestamp.
    for (const c of view.coverage) if (c.status === "available" && c.through && this.now() - Date.parse(c.through) > 10_000) c.status = "stale";
    return view;
  }
  private emptyNodes(): MonitoringSnapshot["nodes"] {
    const node = primaryNode(this.registry.nodes, this.registry.runtimes);
    const absent = <T>(type: Parameters<typeof sample>[0], source: string) => sample<T>(type, source, this.hostAttempt ?? this.startedAt, undefined,
      { status: this.hostAttempt ? "error" : "unavailable", reason: this.hostAttempt ? "host_collection_failed" : "not_collected" });
    const psi = (resource: string) => ({ some: { avg10: absent<number>("percent", `proc-psi-${resource}`), avg60: absent<number>("percent", `proc-psi-${resource}`), avg300: absent<number>("percent", `proc-psi-${resource}`), total: absent<string>("psiTotal", `proc-psi-${resource}`) },
      full: { avg10: absent<number>("percent", `proc-psi-${resource}`), avg60: absent<number>("percent", `proc-psi-${resource}`), avg300: absent<number>("percent", `proc-psi-${resource}`), total: absent<string>("psiTotal", `proc-psi-${resource}`) } });
    return [{ nodeId: node.id, hostBootId: "host-unavailable", scope: "local_host",
      cpu: { logicalCores: absent<number>("count", "proc-stat"), utilization: absent<number>("cpuPercent", "proc-stat"), load1: absent<number>("load", "proc-loadavg"), load5: absent<number>("load", "proc-loadavg"), load15: absent<number>("load", "proc-loadavg"), psi: psi("cpu") },
      memory: { memTotal: absent<number>("bytes", "proc-meminfo"), memAvailable: absent<number>("bytes", "proc-meminfo"), swapTotal: absent<number>("bytes", "proc-meminfo"), swapUsed: absent<number>("bytes", "proc-meminfo"),
        swapIn: absent<string>("pages", "proc-vmstat"), swapOut: absent<string>("pages", "proc-vmstat"), pageSize: absent<number>("bytes", "sysconf"), psi: psi("memory"), oomKills: absent<string>("counter", "proc-vmstat"), aggregationPolicy: "do_not_add_host_vram_gtt" }, gpus: absent("devices", "drm-sysfs") }];
  }
  eventPage(cursor?: string, limit?: number) { return this.events.read(cursor, limit, this.snapshot()?.coverage ?? this.coverage()); }
}
